"""《AFTERGLOW 星痕》分镜：128 BPM，1 拍 = 0.46875 s，1 小节 = 1.875 s。每个镜头的 t0/t1 都落在拍点上。

kf    关键帧画面（Qwen 编辑生成，角色参考 = 设定图）
move  这一镜的运动（FastH3 Omni 多参考：关键帧钉在第 0 帧）
src   从生成视频里截取的起点（秒），跳过开头静止的部分
"""
B = 60 / 128  # one beat


def at(bar, beat=0.0):
    return round(bar * 4 * B + beat * B, 5)


SHOTS = [
    # ---- 前奏 0-3.75 ----
    dict(id="s01", t0=at(0), t1=at(1), kf="Extreme wide shot at night: a vast neon cyberpunk city in heavy rain, glowing skyscrapers in blue and magenta, "
         "tiny silhouette of the girl standing on the edge of a tall rooftop seen from behind, her long silver hair and the cyan tips glowing faintly, rain streaks",
         move="Slow cinematic crane down toward the girl on the rooftop, heavy rain falling, neon lights flicker, her hair sways in the wind."),
    dict(id="s02", t0=at(1), t1=at(2), kf="Extreme close-up of the girl's face in the rain, eyes closed, raindrops on her eyelashes and cheeks, cyan neon reflections on wet skin, dark background",
         move="She slowly opens her eyes, revealing bright violet eyes that begin to glow, raindrops run down her face, very subtle push-in."),
    # ---- 推进 3.75-7.5 ----
    dict(id="s03", t0=at(2), t1=at(3), kf="Low angle medium shot: the girl sprinting across a wet rooftop toward the camera at night, hair and skirt streaming behind her, splashes at her boots, neon city behind",
         move="She sprints fast toward the camera across the wet rooftop, water splashing with every step, camera tracks backward, hair streaming."),
    dict(id="s04", t0=at(3), t1=at(3, 2), kf="Close-up of the girl's gloved hand gripping the white katana handle at her hip, cyan light leaking from the sheath, rain drops, dramatic side light",
         move="Her hand tightens on the katana handle and pulls it a few centimeters out, intense cyan light bursts from the gap, sparks of light."),
    dict(id="s05", t0=at(3, 2), t1=at(3, 3), kf="Wide shot: silhouette of the girl leaping off the rooftop edge against a huge full moon behind clouds, hair flowing, city lights far below",
         move="She leaps off the rooftop edge into the night sky in front of the full moon, hair and skirt flowing, camera holds still."),
    # ---- drop 1 7.5-15 ----
    dict(id="s06", t0=at(4), t1=at(4, 2), kf="Dynamic mid shot: the girl drawing her glowing cyan katana in a powerful horizontal slash, a huge bright cyan crescent arc of light cutting across the frame, rain droplets frozen, speed lines",
         move="She draws the katana in one explosive horizontal slash, a huge crescent arc of cyan light sweeps across the frame, rain scatters, strong camera shake."),
    dict(id="s07", t0=at(4, 2), t1=at(5), kf="Wide shot: the girl spinning in mid-air among falling rain and shattered glowing glass shards, neon city below, her katana leaving a cyan light trail",
         move="She spins in mid-air, the katana leaving a spiral trail of cyan light, glass shards and rain swirl around her, camera orbits around her."),
    dict(id="s08", t0=at(5), t1=at(5, 2), kf="Close-up of the girl's determined face, violet eyes glowing, silver hair whipping across her face in strong wind, cyan light reflections, rain",
         move="Close-up: her hair whips violently in the wind, her glowing violet eyes narrow with determination, slight push-in, rain streaks past."),
    dict(id="s09", t0=at(5, 2), t1=at(6), kf="Wide action shot: the girl slicing through a giant dark mechanical shadow monster with red glowing eyes towering over the city, a line of blinding cyan light splitting the monster in half",
         move="She dashes past the giant dark mechanical monster, a line of cyan light splits it in half and it breaks apart into black fragments, explosion of light."),
    dict(id="s10", t0=at(6), t1=at(6, 2), kf="Dynamic tilted shot: the girl running along the vertical glass wall of a skyscraper at night, neon signs streaking past, motion blur, hair flowing back",
         move="She runs straight down the vertical glass wall of a skyscraper, neon signs streak past with motion blur, glass cracks under her boots."),
    dict(id="s11", t0=at(6, 2), t1=at(7), kf="Low angle hero shot: the girl landing on one knee on a wet street, katana planted beside her, the ground cracking with glowing cyan lines radiating outward, rain splashes",
         move="She lands hard on one knee, a shockwave of water explodes outward and glowing cyan cracks spread across the street, she slowly raises her head."),
    dict(id="s12", t0=at(7), t1=at(7, 1), kf="Extreme close-up of one violet glowing eye with a cyan reflection of a sword arc in the iris, eyelashes, raindrops",
         move="Extreme close-up: the violet eye sharply focuses, the glow in the iris pulses brighter."),
    dict(id="s13", t0=at(7, 1), t1=at(7, 2), kf="Medium shot: the girl spinning her glowing katana in one hand, a circle of cyan light, sparks, dark rainy background",
         move="She spins the glowing katana in a fast circle in one hand, forming a ring of cyan light, sparks fly."),
    dict(id="s14", t0=at(7, 2), t1=at(8), kf="Medium shot from behind: the girl looking up at a dark stormy sky as a single beam of golden light breaks through the clouds onto her, rain slowing",
         move="She looks up as a beam of warm golden light breaks through the storm clouds and shines on her, the rain slows down, camera slowly tilts up."),
    # ---- 安静段 15-18.75 ----
    dict(id="s15", t0=at(8), t1=at(9), kf="Soft memory scene: the girl standing on a quiet rooftop at sunset, warm orange and pink sky, gentle wind with drifting cherry blossom petals, she smiles softly at the camera, hair glowing in the backlight, dreamy soft focus",
         move="Gentle breeze, cherry blossom petals drift past, she smiles softly and tucks her hair behind her ear, warm sunset light, very slow push-in."),
    dict(id="s16", t0=at(9), t1=at(10), kf="Close-up of the girl's face in soft warm light with eyes closed, a single tear running down her cheek, holding the glowing crescent-moon hairpin near her lips",
         move="A single tear rolls down her cheek, she holds the crescent hairpin close and gently closes her hand around it, soft light flickers."),
    # ---- 推进 2 18.75-22.5 ----
    dict(id="s17", t0=at(10), t1=at(11), kf="Medium shot: the girl standing on a rooftop at night raising her katana vertically before her face, swirling cyan energy and wind spiraling around her, hair floating upward, eyes glowing",
         move="Swirling cyan energy spirals faster and faster around her, her hair floats upward, the katana blade glows brighter and brighter, camera slowly circles."),
    dict(id="s18", t0=at(11), t1=at(11, 2), kf="Epic wide shot: a colossal dark storm cloud with a giant glowing red eye looming over the entire neon city, lightning, tiny girl silhouette on a rooftop in the foreground",
         move="The colossal storm cloud churns over the city, red lightning flashes, the giant red eye opens wider, camera slowly pushes toward it."),
    dict(id="s19", t0=at(11, 2), t1=at(11, 3), kf="Low angle close shot: the girl crouching low ready to jump, katana held back, cyan energy gathering at her feet, rain bouncing off the roof",
         move="She crouches lower, cyan energy compresses under her feet, then she launches upward."),
    # ---- drop 2 22.5-28.125 ----
    dict(id="s20", t0=at(12), t1=at(12, 2), kf="Dynamic upward shot: the girl rocketing straight up into the stormy sky leaving a long bright cyan light trail, city falling away below, hair streaming",
         move="She rockets straight up into the sky leaving a long trail of cyan light, the city drops away below, clouds rush past the camera."),
    dict(id="s21", t0=at(12, 2), t1=at(13), kf="The girl spiraling upward through dark storm clouds, a spiral of cyan light around her, lightning flashes",
         move="She spirals upward through the dark storm clouds, the cyan light spiral tightens around her, lightning flashes across the clouds."),
    dict(id="s22", t0=at(13), t1=at(13, 2), kf="Close-up of the girl shouting with fierce determination, glowing violet eyes, intense cyan aura and wind around her, hair whipping",
         move="She shouts with all her strength, an intense cyan aura bursts outward from her, hair whipping violently, strong camera shake."),
    dict(id="s23", t0=at(13, 2), t1=at(14), kf="Epic wide shot: the girl delivering one enormous vertical katana slash that cleaves the giant storm cloud in half, a colossal line of white-cyan light splitting the sky, golden sunlight pouring through the gap",
         move="One enormous vertical slash splits the giant storm cloud in half, a colossal line of light tears the sky open and golden sunlight floods through the gap."),
    dict(id="s24", t0=at(14), t1=at(14, 2), kf="Breathtaking wide shot: sunrise over a sea of clouds, the girl floating in the golden sky, her silver hair glowing, the clouds parting below, warm golden light",
         move="She floats gently in the golden sunrise above a sea of clouds, hair and skirt drifting slowly, light rays, camera slowly glides around her."),
    dict(id="s25", t0=at(14, 2), t1=at(15), kf="Close-up: the girl turning toward the camera with a gentle warm smile in the golden sunrise light, hair glowing, petals of light floating",
         move="She turns toward the camera and smiles gently, golden light on her face, glowing particles float by."),
    # ---- 收尾 28.125-30：片名（剪辑时叠字） ----
    dict(id="s26", t0=at(15), t1=30.0, kf="Wide silhouette shot: the girl standing on top of a sea of clouds facing a huge rising sun, katana resting on her shoulder, long hair blowing, golden sky, lots of empty sky for a title",
         move="Very slow push-in, her hair and the clouds drift slowly in the wind, golden light shimmers."),
]
