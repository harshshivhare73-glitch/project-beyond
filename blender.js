'use strict';
// Project Beyond — Milestone 3 / Phase 2: Blender 3D Graphics Generator
// Supports both local headless Blender rendering and remote execution via GitHub Actions.
// Enforces zero-unauthorized-downloads, path traversal protection, credential masking,
// and truthful multi-stage pipeline status reporting.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  writeArtifact,
  resolveSafePath,
  resolveWorkspaceDir,
} = require('./artifacts');

// Set to prevent duplicate concurrent remote render dispatches
const activeCloudRenders = new Set();

/**
 * Masks sensitive tokens for safe display and logging.
 * @param {string} key
 * @returns {string|null}
 */
function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const t = key.trim();
  if (t.length <= 8) return '****';
  return t.slice(0, 3) + '...' + t.slice(-4);
}

/**
 * Inspects environment for GitHub Actions remote execution configuration.
 * Checks GITHUB_TOKEN (or GH_TOKEN) and GITHUB_REPOSITORY (or GITHUB_REPO).
 * Never leaks raw secrets.
 *
 * @returns {object}
 */
function detectGitHubRemote() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const repository = process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || null;
  const workflowFile = path.join(__dirname, '.github', 'workflows', 'blender-render.yml');
  const workflowExists = fs.existsSync(workflowFile);

  const hasToken = Boolean(token && token.trim().length > 0);
  const hasRepo = Boolean(repository && repository.includes('/'));
  const configured = Boolean(hasToken && hasRepo && workflowExists);

  let reason = '';
  if (!workflowExists) {
    reason = 'Workflow file .github/workflows/blender-render.yml is missing.';
  } else if (!hasToken && !hasRepo) {
    reason = 'Both GITHUB_TOKEN and GITHUB_REPOSITORY are not set in environment or .env.';
  } else if (!hasToken) {
    reason = 'GITHUB_TOKEN is not set in environment or .env.';
  } else if (!hasRepo) {
    reason = 'GITHUB_REPOSITORY (owner/repo) is not set in environment or .env.';
  } else {
    reason = `GitHub Actions remote renderer configured for repository "${repository.trim()}".`;
  }

  return {
    configured,
    hasToken,
    hasRepo,
    repository: repository ? repository.trim() : null,
    maskedToken: hasToken ? maskKey(token) : null,
    workflowExists,
    workflowPath: '.github/workflows/blender-render.yml',
    reason,
  };
}

/**
 * Searches standard Windows and system locations for a valid local Blender executable.
 * Never attempts to download, install, or modify system software.
 *
 * @param {string} [customPath] Explicit executable path or override
 * @returns {object} Local detection result
 */
function detectLocalBlender(customPath = null) {
  const checkedPaths = [];

  // 1. Explicit override or environment variable
  const envPath = customPath || process.env.BLENDER_PATH;
  if (envPath) {
    checkedPaths.push(envPath);
    if (fs.existsSync(envPath)) {
      const ver = probeBlenderVersion(envPath);
      if (ver.ok) {
        return {
          available: true,
          executable: envPath,
          version: ver.version,
          checkedPaths,
          source: 'environment_override',
        };
      }
    }
  }

  // 2. Standard Windows installation directories
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

  const baseDirs = [
    path.join(programFiles, 'Blender Foundation'),
    path.join(programFilesX86, 'Blender Foundation'),
    path.join(localAppData, 'Programs', 'Blender Foundation'),
    path.join(localAppData, 'Programs'),
    path.join(programFiles, 'Steam', 'steamapps', 'common', 'Blender'),
    path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'Blender'),
    'C:\\blender',
    'D:\\blender',
  ];

  for (const baseDir of baseDirs) {
    checkedPaths.push(baseDir);
    if (fs.existsSync(baseDir)) {
      const directExe = path.join(baseDir, 'blender.exe');
      if (fs.existsSync(directExe)) {
        const ver = probeBlenderVersion(directExe);
        if (ver.ok) {
          return {
            available: true,
            executable: directExe,
            version: ver.version,
            checkedPaths,
            source: 'standard_directory',
          };
        }
      }

      try {
        const subdirs = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const sub of subdirs) {
          if (sub.isDirectory()) {
            const candidateExe = path.join(baseDir, sub.name, 'blender.exe');
            checkedPaths.push(candidateExe);
            if (fs.existsSync(candidateExe)) {
              const ver = probeBlenderVersion(candidateExe);
              if (ver.ok) {
                return {
                  available: true,
                  executable: candidateExe,
                  version: ver.version,
                  checkedPaths,
                  source: 'standard_versioned_directory',
                };
              }
            }
          }
        }
      } catch {}
    }
  }

  // 3. System PATH check via where.exe (Windows)
  try {
    const whereResult = spawnSync('where.exe', ['blender.exe'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (whereResult.status === 0 && whereResult.stdout) {
      const foundPath = whereResult.stdout.split(/\r?\n/)[0].trim();
      if (foundPath && fs.existsSync(foundPath)) {
        checkedPaths.push(foundPath);
        const ver = probeBlenderVersion(foundPath);
        if (ver.ok) {
          return {
            available: true,
            executable: foundPath,
            version: ver.version,
            checkedPaths,
            source: 'system_path',
          };
        }
      }
    }
  } catch {}

  return {
    available: false,
    executable: null,
    version: null,
    checkedPaths,
    reason: 'Blender executable was not found in standard system directories, Steam libraries, or PATH. Set BLENDER_PATH environment variable to specify a custom installation.',
  };
}

/**
 * Comprehensive Blender status check covering both local installation and remote cloud runner.
 *
 * @param {string} [customPath] Explicit local executable path or override
 * @returns {object} Combined status
 */
function detectBlender(customPath = null) {
  const local = detectLocalBlender(customPath);
  const remote = detectGitHubRemote();
  const available = local.available || remote.configured;

  let mode = 'blocked';
  if (local.available) {
    mode = 'local';
  } else if (remote.configured) {
    mode = 'cloud';
  }

  let reason = '';
  if (local.available) {
    reason = `Blender installed locally (${local.version || local.executable}).`;
  } else if (remote.configured) {
    reason = `Local Blender is not installed, but remote rendering is ready via GitHub Actions (${remote.repository}).`;
  } else {
    reason = `${local.reason} Additionally, remote rendering is not configured (${remote.reason}).`;
  }

  return {
    available,
    executable: local.executable,
    version: local.version,
    checkedPaths: local.checkedPaths,
    source: local.available ? local.source : (remote.configured ? 'github_actions' : null),
    mode,
    local,
    remote,
    reason,
  };
}

/**
 * Executes blender.exe --version to safely identify version and ensure binary integrity.
 * @param {string} exePath
 * @returns {{ ok: boolean, version: string|null, error: string|null }}
 */
function probeBlenderVersion(exePath) {
  try {
    const res = spawnSync(exePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const firstLine = res.stdout.split(/\r?\n/)[0].trim();
      return { ok: true, version: firstLine, error: null };
    }
    return { ok: false, version: null, error: `Process exited with code ${res.status}` };
  } catch (err) {
    return { ok: false, version: null, error: err.message };
  }
}

/**
 * Extracts a ZIP archive to a destination directory using built-in Windows tools (tar or PowerShell).
 * @param {string} zipPath
 * @param {string} targetDir
 * @returns {boolean}
 */
function extractArtifactZip(zipPath, targetDir) {
  try {
    const res = spawnSync('tar', ['-xf', zipPath, '-C', targetDir], { windowsHide: true, timeout: 15000 });
    if (res.status === 0) return true;
  } catch {}

  try {
    const psRes = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`
    ], { windowsHide: true, timeout: 20000 });
    if (psRes.status === 0) return true;
  } catch {}

  return false;
}

/**
 * Synthesizes a self-contained, isolated Python script for Blender scene creation and rendering.
 * Does NOT require external Python packages or network calls.
 *
 * @param {object} options
 * @param {string} options.blendPath Absolute path where .blend should be saved
 * @param {string} options.renderPath Absolute path where output PNG should be written
 * @param {string} [options.objectType='gem'] 'gem' | 'suzanne' | 'torus' | 'cylinder'
 * @param {string} [options.sceneTitle]
 * @param {number} [options.resolutionX=800]
 * @param {number} [options.resolutionY=600]
 * @param {number} [options.samples=32]
 * @returns {string} Generated Python script code
 */
function generate3DSceneScript(options = {}) {
  const blendPathEscaped = (options.blendPath || 'scene.blend').replace(/\\/g, '/');
  const renderPathEscaped = (options.renderPath || 'render.png').replace(/\\/g, '/');
  const objectType = (options.objectType || 'gem').toLowerCase();
  const sceneTitle = (options.sceneTitle || 'Project Beyond 3D Showcase').replace(/"/g, '\\"');
  const resX = Number(options.resolutionX) || 800;
  const resY = Number(options.resolutionY) || 600;
  const samples = Number(options.samples) || 32;

  return `# Project Beyond — 3D Scene Generation Script
# Automated Blender Python Generator (bpy)
# Target: "${sceneTitle}"

import bpy
import math
import os
import sys

def _pb_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    traceback.print_exception(exc_type, exc_value, exc_traceback)
    sys.exit(1)
sys.excepthook = _pb_excepthook

print("[Project Beyond] Starting 3D Scene Generation: ${sceneTitle}")

# ---------------------------------------------------------
# 1. CLEAN SCENE
# ---------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------
# 2. RENDER SETTINGS & ENGINE CONFIGURATION
# ---------------------------------------------------------
scene = bpy.context.scene

available_engines = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
if 'BLENDER_EEVEE_NEXT' in available_engines:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
elif 'BLENDER_EEVEE' in available_engines:
    scene.render.engine = 'BLENDER_EEVEE'
else:
    scene.render.engine = 'CYCLES'
    if hasattr(scene, 'cycles'):
        scene.cycles.samples = ${samples}

scene.render.resolution_x = ${resX}
scene.render.resolution_y = ${resY}
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.compression = 15

# Resolve output target paths portably (supports local workspace, cloud CI runners, and containers)
blend_file_path = r"${blendPathEscaped}"
render_file_path = r"${renderPathEscaped}"

# In CI/GitHub Actions runners or non-Windows runners with Windows drive paths,
# route outputs to the standard 'output/' directory expected by cloud runners
if os.environ.get("GITHUB_ACTIONS") or (os.name != 'nt' and (blend_file_path.startswith(('C:', 'c:', 'D:', 'd:')) or '\\\\' in blend_file_path)):
    out_dir = os.path.abspath("output")
    os.makedirs(out_dir, exist_ok=True)
    blend_file_path = os.path.join(out_dir, "scene.blend")
    render_file_path = os.path.join(out_dir, "render.png")

scene.render.filepath = render_file_path

# ---------------------------------------------------------
# 3. 3D OBJECT GEOMETRY CREATION
# ---------------------------------------------------------
${
  objectType === 'suzanne'
    ? `bpy.ops.mesh.primitive_monkey_add(size=2.0, location=(0, 0, 0))`
    : objectType === 'torus'
    ? `bpy.ops.mesh.primitive_torus_add(major_radius=1.5, minor_radius=0.5, location=(0, 0, 0))`
    : `bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.4, location=(0, 0, 0))`
}
main_obj = bpy.context.active_object
main_obj.name = "ShowcaseObject"

sub_mod = main_obj.modifiers.new(name="Subdivision", type='SUBSURF')
sub_mod.levels = 1
sub_mod.render_levels = 2
bpy.ops.object.shade_smooth()

# Ground plane
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -1.5))
ground_obj = bpy.context.active_object
ground_obj.name = "GroundPlane"

# ---------------------------------------------------------
# 4. REALISTIC PBR MATERIALS (Principled BSDF)
# ---------------------------------------------------------
obj_mat = bpy.data.materials.new(name="PBR_Hero_Material")
obj_mat.use_nodes = True
nodes = obj_mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")

if bsdf:
    if hasattr(bsdf.inputs['Base Color'], 'default_value'):
        bsdf.inputs['Base Color'].default_value = (0.12, 0.72, 1.0, 1.0)
    if 'Metallic' in bsdf.inputs:
        bsdf.inputs['Metallic'].default_value = 0.85
    if 'Roughness' in bsdf.inputs:
        bsdf.inputs['Roughness'].default_value = 0.18

if main_obj.data.materials:
    main_obj.data.materials[0] = obj_mat
else:
    main_obj.data.materials.append(obj_mat)

ground_mat = bpy.data.materials.new(name="PBR_Studio_Floor")
ground_mat.use_nodes = True
g_nodes = ground_mat.node_tree.nodes
g_bsdf = g_nodes.get("Principled BSDF")
if g_bsdf:
    g_bsdf.inputs['Base Color'].default_value = (0.04, 0.05, 0.12, 1.0)
    if 'Roughness' in g_bsdf.inputs:
        g_bsdf.inputs['Roughness'].default_value = 0.65

ground_obj.data.materials.append(ground_mat)

# ---------------------------------------------------------
# 5. THREE-POINT STUDIO LIGHTING (Key, Fill, Rim)
# ---------------------------------------------------------
key_light_data = bpy.data.lights.new(name="Key_Light", type='AREA')
key_light_data.energy = 850.0
key_light_data.color = (1.0, 0.95, 0.85)
key_light_data.size = 3.0
key_light_obj = bpy.data.objects.new(name="Key_Light", object_data=key_light_data)
scene.collection.objects.link(key_light_obj)
key_light_obj.location = (4.0, -4.0, 4.5)
key_light_obj.rotation_euler = (math.radians(45), 0, math.radians(45))

fill_light_data = bpy.data.lights.new(name="Fill_Light", type='AREA')
fill_light_data.energy = 350.0
fill_light_data.color = (0.75, 0.85, 1.0)
fill_light_data.size = 4.5
fill_light_obj = bpy.data.objects.new(name="Fill_Light", object_data=fill_light_data)
scene.collection.objects.link(fill_light_obj)
fill_light_obj.location = (-4.5, -2.5, 2.5)
fill_light_obj.rotation_euler = (math.radians(35), 0, math.radians(-55))

rim_light_data = bpy.data.lights.new(name="Rim_Light", type='POINT')
rim_light_data.energy = 500.0
rim_light_data.color = (0.85, 0.35, 1.0)
rim_light_obj = bpy.data.objects.new(name="Rim_Light", object_data=rim_light_data)
scene.collection.objects.link(rim_light_obj)
rim_light_obj.location = (0.0, 4.0, 3.5)

# ---------------------------------------------------------
# 6. CAMERA & CINEMATIC COMPOSITION
# ---------------------------------------------------------
cam_data = bpy.data.cameras.new(name="StudioCamera")
cam_data.lens = 50.0
cam_obj = bpy.data.objects.new(name="StudioCamera", object_data=cam_data)
scene.collection.objects.link(cam_obj)
scene.camera = cam_obj

cam_obj.location = (4.8, -5.2, 3.4)
cam_obj.rotation_euler = (math.radians(62), 0, math.radians(42))

# ---------------------------------------------------------
# 7. SAVE PROJECT (.blend)
# ---------------------------------------------------------
os.makedirs(os.path.dirname(os.path.abspath(blend_file_path)), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=blend_file_path)
print(f"VERIFIED_BLEND_SAVED: {blend_file_path}")

# ---------------------------------------------------------
# 8. RENDER STILL IMAGE (.png)
# ---------------------------------------------------------
os.makedirs(os.path.dirname(os.path.abspath(render_file_path)), exist_ok=True)
bpy.ops.render.render(write_still=True)
print(f"VERIFIED_RENDER_SAVED: {render_file_path}")
print("[Project Beyond] 3D Generation Pipeline Completed Successfully.")
`;
}

/**
 * Dispatches headless Blender rendering to a GitHub Actions runner.
 * Safe timeout, input validation, artifact downloading, and magic byte verification.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function dispatchRemoteBlenderRender({
  goal,
  safeTargetDir,
  projectAbsDir,
  baseDir,
  scriptAbsPath,
  scriptArtifact,
  stages,
  addLog,
  customTimeoutMs = 180000,
}) {
  const remote = detectGitHubRemote();

  if (!remote.configured) {
    if (addLog) {
      addLog('warn', `3D Remote Generator: Cloud rendering blocked. ${remote.reason}`);
    }
    return {
      ok: false,
      status: 'blocked',
      mode: 'cloud',
      reason: `GitHub Actions remote rendering is not configured: ${remote.reason}`,
      remote,
      stages,
      artifacts: [scriptArtifact],
      projectDir: safeTargetDir,
      scriptPath: scriptAbsPath,
      blendPath: null,
      renderPath: null,
    };
  }

  if (activeCloudRenders.has(safeTargetDir)) {
    return {
      ok: false,
      status: 'conflict',
      error: `A remote render job is already running for project "${safeTargetDir}".`,
      stages,
      artifacts: [scriptArtifact],
    };
  }

  activeCloudRenders.add(safeTargetDir);
  try {
    const pythonScript = fs.readFileSync(scriptAbsPath, 'utf8');
    const b64Script = Buffer.from(pythonScript, 'utf8').toString('base64');
    const [owner, repo] = remote.repository.split('/');
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (addLog) {
      addLog('info', `3D Remote Generator: Dispatching job to GitHub Actions (${remote.repository})...`);
    }

    const dispatchTime = Date.now();
    const dispatchUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/blender-render.yml/dispatches`;
    const dispatchRes = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ProjectBeyond-RemoteRenderer/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          scene_title: goal || '3D Scene',
          script_content: b64Script,
          resolution_x: '800',
          resolution_y: '600',
        },
      }),
    });

    if (dispatchRes.status !== 204) {
      const errText = await dispatchRes.text().catch(() => '');
      throw new Error(`GitHub dispatch failed with HTTP ${dispatchRes.status}: ${errText.slice(0, 300)}`);
    }

    if (addLog) {
      addLog('ok', `3D Remote Generator: Workflow dispatched successfully. Waiting for runner execution...`);
    }

    const startTime = Date.now();
    let runId = null;

    while (Date.now() - startTime < customTimeoutMs) {
      await new Promise(r => setTimeout(r, 4000));
      if (!runId) {
        const listRunsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/blender-render.yml/runs?event=workflow_dispatch&per_page=5`;
        const listRes = await fetch(listRunsUrl, {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'ProjectBeyond-RemoteRenderer/1.0',
          },
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const candidate = (listData.workflow_runs || []).find(r => new Date(r.created_at).getTime() >= (dispatchTime - 30000));
          if (candidate) {
            runId = candidate.id;
            if (addLog) {
              addLog('info', `3D Remote Generator: Located workflow run #${runId} (${candidate.status}).`);
            }
          }
        }
      }

      if (runId) {
        const runUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`;
        const runRes = await fetch(runUrl, {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'ProjectBeyond-RemoteRenderer/1.0',
          },
        });
        if (runRes.ok) {
          const runData = await runRes.json();
          if (runData.status === 'completed') {
            if (runData.conclusion === 'success') {
              stages.scene_created = true;
              stages.render_completed = true;

              const artifactsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/artifacts`;
              const artRes = await fetch(artifactsUrl, {
                headers: {
                  'Accept': 'application/vnd.github+json',
                  'Authorization': `Bearer ${token}`,
                  'X-GitHub-Api-Version': '2022-11-28',
                  'User-Agent': 'ProjectBeyond-RemoteRenderer/1.0',
                },
              });
              const artData = await artRes.json();
              const targetArt = (artData.artifacts || []).find(a => a.name === 'blender-render-artifacts');
              if (!targetArt) {
                throw new Error('Remote workflow completed, but blender-render-artifacts was not found.');
              }

              const dlRes = await fetch(targetArt.archive_download_url, {
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'User-Agent': 'ProjectBeyond-RemoteRenderer/1.0',
                },
              });
              if (!dlRes.ok) {
                throw new Error(`Failed to download artifact archive: HTTP ${dlRes.status}`);
              }

              const zipBuffer = Buffer.from(await dlRes.arrayBuffer());
              const tempZipPath = resolveSafePath(projectAbsDir, 'artifacts.zip');
              fs.writeFileSync(tempZipPath, zipBuffer);

              const unpacked = extractArtifactZip(tempZipPath, projectAbsDir);
              try { fs.unlinkSync(tempZipPath); } catch {}
              if (!unpacked) {
                throw new Error('Failed to extract artifact zip downloaded from GitHub Actions.');
              }

              const blendAbsPath = resolveSafePath(baseDir, `${safeTargetDir}/scene.blend`);
              const renderAbsPath = resolveSafePath(baseDir, `${safeTargetDir}/render.png`);
              const blendExists = fs.existsSync(blendAbsPath) && fs.statSync(blendAbsPath).size > 0;
              const renderExists = fs.existsSync(renderAbsPath) && fs.statSync(renderAbsPath).size > 0;

              let isPngValid = false;
              if (renderExists) {
                const head = Buffer.alloc(8);
                const fd = fs.openSync(renderAbsPath, 'r');
                fs.readSync(fd, head, 0, 8, 0);
                fs.closeSync(fd);
                isPngValid = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
              }

              if (blendExists && renderExists && isPngValid) {
                stages.output_verified = true;
                if (addLog) {
                  addLog('ok', `3D Remote Generator: Cloud render downloaded and verified (${fs.statSync(renderAbsPath).size} bytes PNG).`);
                }
                return {
                  ok: true,
                  status: 'completed',
                  mode: 'cloud',
                  remote,
                  stages,
                  runId,
                  projectDir: safeTargetDir,
                  scriptPath: scriptAbsPath,
                  blendPath: blendAbsPath,
                  renderPath: renderAbsPath,
                  artifacts: [
                    scriptArtifact,
                    { relativePath: `${safeTargetDir}/scene.blend`, absolutePath: blendAbsPath, size: fs.statSync(blendAbsPath).size, status: 'written', type: 'blend' },
                    { relativePath: `${safeTargetDir}/render.png`, absolutePath: renderAbsPath, size: fs.statSync(renderAbsPath).size, status: 'written', type: 'png' },
                  ],
                };
              } else {
                throw new Error('Downloaded cloud artifacts failed verification checks.');
              }
            } else {
              throw new Error(`Remote GitHub Actions workflow finished with conclusion "${runData.conclusion}".`);
            }
          }
        }
      }
    }

    throw new Error(`Remote render workflow timed out after ${customTimeoutMs / 1000}s.`);
  } catch (err) {
    if (addLog) {
      addLog('error', `3D Remote Generator failed: ${err.message}`);
    }
    return {
      ok: false,
      status: 'failed',
      mode: 'cloud',
      error: err.message,
      remote,
      stages,
      artifacts: [scriptArtifact],
    };
  } finally {
    activeCloudRenders.delete(safeTargetDir);
  }
}

/**
 * Executes a controlled 3D graphics generation pipeline.
 * Supports mode 'auto' (prefers local if installed, falls back to cloud), 'local', or 'cloud'.
 *
 * Tracks stages:
 * - script_generated: boolean
 * - scene_created: boolean
 * - render_completed: boolean
 * - output_verified: boolean
 *
 * @param {object} params
 * @param {string} params.goal Description of 3D visual request
 * @param {string} [params.targetDir='3d-scene'] Subdirectory inside workspace
 * @param {string} [params.workspaceDir] Workspace root
 * @param {string} [params.mode='auto'] 'auto' | 'local' | 'cloud'
 * @param {boolean} [params.allowOverwrite=true]
 * @param {function} [params.addLog] Logger
 * @returns {Promise<object>} Execution result
 */
async function generate3DScene({
  goal,
  targetDir = '3d-scene',
  workspaceDir = null,
  mode = 'auto',
  allowOverwrite = true,
  addLog = null,
  customTimeoutMs = 30000,
}) {
  const baseDir = resolveWorkspaceDir(workspaceDir);
  const safeTargetDir = targetDir.replace(/[^a-zA-Z0-9_\-]/g, '').trim() || '3d-scene';
  const projectAbsDir = resolveSafePath(baseDir, safeTargetDir);

  fs.mkdirSync(projectAbsDir, { recursive: true });

  const scriptRelativePath = `${safeTargetDir}/scene.py`;
  const blendRelativePath = `${safeTargetDir}/scene.blend`;
  const renderRelativePath = `${safeTargetDir}/render.png`;

  const scriptAbsPath = resolveSafePath(baseDir, scriptRelativePath);
  const blendAbsPath = resolveSafePath(baseDir, blendRelativePath);
  const renderAbsPath = resolveSafePath(baseDir, renderRelativePath);

  const stages = {
    script_generated: false,
    scene_created: false,
    render_completed: false,
    output_verified: false,
  };

  if (addLog) {
    addLog('info', `3D Generator: Preparing scene synthesis for "${goal || '3D Asset'}"...`);
  }

  // ------------------------------------------------------------------
  // STAGE 1: PYTHON SCRIPT SYNTHESIS
  // ------------------------------------------------------------------
  const pythonScript = generate3DSceneScript({
    blendPath: blendAbsPath,
    renderPath: renderAbsPath,
    sceneTitle: goal || '3D Scene',
    objectType: (goal && goal.toLowerCase().includes('monkey')) ? 'suzanne' : (goal && goal.toLowerCase().includes('torus')) ? 'torus' : 'gem',
    resolutionX: 800,
    resolutionY: 600,
    samples: 32,
  });

  const scriptArtifact = writeArtifact({
    workspaceDir: baseDir,
    relativePath: scriptRelativePath,
    content: pythonScript,
    allowOverwrite: true,
    expectedType: 'text',
  });

  stages.script_generated = true;
  if (addLog) {
    addLog('ok', `3D Generator: Generated Blender Python script [${scriptRelativePath}] (${scriptArtifact.size} bytes).`);
  }

  // ------------------------------------------------------------------
  // EXECUTION MODE SELECTION & GUARD
  // ------------------------------------------------------------------
  const detection = detectBlender();
  const canRunLocal = Boolean(detection.local && detection.local.available);
  const canRunCloud = Boolean(detection.remote && detection.remote.configured);

  let chosenMode = mode;
  if (chosenMode === 'auto') {
    chosenMode = canRunLocal ? 'local' : (canRunCloud ? 'cloud' : 'blocked');
  }

  if (chosenMode === 'cloud') {
    return await dispatchRemoteBlenderRender({
      goal,
      safeTargetDir,
      projectAbsDir,
      baseDir,
      scriptAbsPath,
      scriptArtifact,
      stages,
      addLog,
      customTimeoutMs,
    });
  }

  if (!canRunLocal) {
    if (addLog) {
      addLog('warn', `3D Generator: Local Blender not installed. Cloud rendering ${canRunCloud ? 'available' : 'not configured'}.`);
    }

    const reason = !detection.local.available && !detection.remote.configured
      ? 'Blender executable not installed on system, and GitHub Actions cloud rendering is not configured. Set GITHUB_TOKEN and GITHUB_REPOSITORY in .env to enable remote rendering, or install Blender locally.'
      : (!detection.local.available ? detection.local.reason : detection.remote.reason);

    return {
      ok: false,
      status: 'blocked',
      mode: chosenMode,
      reason,
      blenderAvailable: false,
      detection,
      stages,
      artifacts: [scriptArtifact],
      projectDir: safeTargetDir,
      scriptPath: scriptAbsPath,
      blendPath: null,
      renderPath: null,
    };
  }

  // ------------------------------------------------------------------
  // LOCAL EXECUTION (CONTROLLED & HEADLESS)
  // ------------------------------------------------------------------
  if (addLog) {
    addLog('info', `3D Generator: Invoking local Blender engine (${detection.version}) headlessly...`);
  }

  let blenderResult;
  try {
    blenderResult = spawnSync(
      detection.executable,
      ['-b', '--python', scriptAbsPath],
      {
        cwd: projectAbsDir,
        encoding: 'utf8',
        timeout: customTimeoutMs,
        windowsHide: true,
      }
    );
  } catch (procErr) {
    return {
      ok: false,
      status: 'failed',
      mode: 'local',
      error: `Failed to spawn Blender process: ${procErr.message}`,
      blenderAvailable: true,
      detection,
      stages,
      artifacts: [scriptArtifact],
    };
  }

  const exitCode = blenderResult.status;
  const stdout = blenderResult.stdout || '';
  const stderr = blenderResult.stderr || '';

  if (exitCode !== 0) {
    if (addLog) {
      addLog('error', `3D Generator: Blender process exited with code ${exitCode}. Error: ${stderr.slice(0, 200)}`);
    }
    return {
      ok: false,
      status: 'failed',
      mode: 'local',
      exitCode,
      error: `Blender render failed with exit code ${exitCode}`,
      stdout: stdout.slice(-1000),
      stderr: stderr.slice(-1000),
      blenderAvailable: true,
      detection,
      stages,
      artifacts: [scriptArtifact],
    };
  }

  // ------------------------------------------------------------------
  // LOCAL OUTPUT VERIFICATION
  // ------------------------------------------------------------------
  const blendExists = fs.existsSync(blendAbsPath) && fs.statSync(blendAbsPath).size > 0;
  if (blendExists) {
    stages.scene_created = true;
  }

  const renderExists = fs.existsSync(renderAbsPath) && fs.statSync(renderAbsPath).size > 0;
  if (renderExists) {
    stages.render_completed = true;

    try {
      const buffer = Buffer.alloc(8);
      const fd = fs.openSync(renderAbsPath, 'r');
      fs.readSync(fd, buffer, 0, 8, 0);
      fs.closeSync(fd);
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      if (isPng) {
        stages.output_verified = true;
      }
    } catch {}
  }

  const artifacts = [scriptArtifact];
  if (blendExists) {
    artifacts.push({
      relativePath: blendRelativePath,
      absolutePath: blendAbsPath,
      size: fs.statSync(blendAbsPath).size,
      status: 'written',
      type: 'blend',
    });
  }
  if (renderExists) {
    artifacts.push({
      relativePath: renderRelativePath,
      absolutePath: renderAbsPath,
      size: fs.statSync(renderAbsPath).size,
      status: 'written',
      type: 'png',
    });
  }

  const isSuccess = stages.output_verified && stages.scene_created;

  if (addLog) {
    if (isSuccess) {
      addLog('ok', `3D Generator: Scene and render physically verified (${fs.statSync(renderAbsPath).size} bytes PNG).`);
    } else {
      addLog('warn', `3D Generator: Execution finished but output verification incomplete.`);
    }
  }

  return {
    ok: isSuccess,
    status: isSuccess ? 'completed' : 'incomplete',
    mode: 'local',
    blenderAvailable: true,
    detection,
    stages,
    exitCode,
    projectDir: safeTargetDir,
    scriptPath: scriptAbsPath,
    blendPath: blendExists ? blendAbsPath : null,
    renderPath: renderExists ? renderAbsPath : null,
    artifacts,
  };
}

module.exports = {
  detectBlender,
  detectLocalBlender,
  detectGitHubRemote,
  probeBlenderVersion,
  generate3DSceneScript,
  generate3DScene,
  dispatchRemoteBlenderRender,
};
