import bpy
import mathutils
import os
import sys

def _pb_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    traceback.print_exception(exc_type, exc_value, exc_traceback)
    sys.exit(1)
sys.excepthook = _pb_excepthook

out = os.path.abspath("output")
os.makedirs(out, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
floor = bpy.context.object
floor.name = "Test Floor"

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.object
cube.name = "Test Cube"
cube.rotation_euler[2] = 0.35

mat = bpy.data.materials.new("Blue Material")
mat.diffuse_color = (0.08, 0.3, 0.8, 1)
cube.data.materials.append(mat)

bpy.ops.object.camera_add(location=(5, -7, 5))
camera = bpy.context.object
direction = mathutils.Vector((0, 0, 1)) - camera.location
camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = camera
camera.data.lens = 50

bpy.ops.object.light_add(type="AREA", location=(2, -3, 6))
light = bpy.context.object
light.data.energy = 800
light.data.shape = "DISK"
light.data.size = 5
direction = mathutils.Vector((0, 0, 0.5)) - light.location
light.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 16
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(out, "render.png")

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "scene.blend"))
bpy.ops.render.render(write_still=True)

print("TEST RENDER COMPLETE")
