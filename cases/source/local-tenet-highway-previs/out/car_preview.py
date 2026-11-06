import bpy, sys, os, math
sys.path.insert(0, os.getcwd()); sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
import boilerplate as bp, car_model as cm
bp.clean_scene()
root = bp.new_object("root"); cm.build(root); root.location.z = cm.ZC
bp.add_ground(); bp.setup_render("EEVEE", res=(640, 360))
bp.add_default_lighting("studio"); bp.add_framing_camera(azimuth_deg=35, elevation_deg=18)
bp.render_views("out/car_views.png", views=((35, 18), (145, 18), (90, 5), (0, 89)), res=(640, 360))
