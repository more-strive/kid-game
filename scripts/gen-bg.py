"""生成 1280x720 场景装饰背景（中间透明，只在上/下边缘作画，不遮挡摄像头画面）"""
import os
import random

OUT = os.path.join("public", "bg")
os.makedirs(OUT, exist_ok=True)
W, H = 1280, 720


def head(name: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" fill="none" id="{name}">\n'
    )


def garden() -> str:
    rnd = random.Random(7)
    s = [head("garden")]
    s.append(
        """  <defs>
    <linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="150" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#a8d8ff" stop-opacity=".95"/>
      <stop offset="1" stop-color="#a8d8ff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="g-hill" x1="0" y1="600" x2="0" y2="720" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7fd08a"/>
      <stop offset="1" stop-color="#4faa63"/>
    </linearGradient>
  </defs>
"""
    )
    s.append('  <rect width="1280" height="150" fill="url(#g-sky)"/>\n')
    # 云
    for cx, cy, sc in [(190, 66, 1.0), (520, 40, 0.75), (980, 74, 1.15)]:
        s.append(f'  <g opacity=".9" transform="translate({cx},{cy}) scale({sc})">\n')
        for dx, dy, r in [(-46, 6, 26), (-14, -8, 34), (24, 2, 28), (54, 8, 20)]:
            s.append(f'    <circle cx="{dx}" cy="{dy}" r="{r}" fill="#ffffff"/>\n')
        s.append("  </g>\n")
    # 草坡（两层）
    s.append(
        '  <path d="M0 646 C 210 610, 420 666, 640 640 C 860 614, 1080 664, 1280 630 L1280 720 L0 720 Z" '
        'fill="url(#g-hill)" opacity=".92"/>\n'
    )
    s.append(
        '  <path d="M0 686 C 240 660, 480 700, 720 682 C 960 664, 1140 698, 1280 676 L1280 720 L0 720 Z" '
        'fill="#3f9455" opacity=".85"/>\n'
    )
    # 小花 / 草丛
    for _ in range(26):
        x = rnd.uniform(10, 1270)
        y = rnd.uniform(668, 714)
        c = rnd.choice(["#fff5b8", "#ffffff", "#ffb3c7", "#ffe08a"])
        s.append(f'  <circle cx="{x:.0f}" cy="{y:.0f}" r="{rnd.uniform(2.5, 4.5):.1f}" fill="{c}" opacity=".85"/>\n')
    s.append("</svg>\n")
    return "".join(s)


def stadium() -> str:
    rnd = random.Random(11)
    s = [head("stadium")]
    s.append(
        """  <defs>
    <linearGradient id="s-stand" x1="0" y1="0" x2="0" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1f2a52" stop-opacity=".96"/>
      <stop offset="1" stop-color="#3b4b86" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="t-track" x1="0" y1="620" x2="0" y2="720" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#c8553d"/>
      <stop offset="1" stop-color="#9c3b2a"/>
    </linearGradient>
  </defs>
"""
    )
    s.append('  <rect width="1280" height="128" fill="url(#s-stand)"/>\n')
    # 观众
    for _ in range(120):
        x = rnd.uniform(0, 1280)
        y = rnd.uniform(18, 96)
        c = rnd.choice(["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#f7f7ff", "#f78c6b"])
        s.append(f'  <circle cx="{x:.0f}" cy="{y:.0f}" r="{rnd.uniform(3, 5):.1f}" fill="{c}" opacity=".55"/>\n')
    # 跑道
    s.append('  <rect y="620" width="1280" height="100" fill="url(#t-track)"/>\n')
    for i, y in enumerate([640, 664, 688, 712]):
        s.append(f'  <rect x="0" y="{y}" width="1280" height="3" fill="#ffffff" opacity="{0.55 - i * 0.08:.2f}"/>\n')
    s.append("</svg>\n")
    return "".join(s)


def stage() -> str:
    rnd = random.Random(23)
    s = [head("stage")]
    s.append(
        """  <defs>
    <linearGradient id="st-light" x1="0" y1="0" x2="0" y2="240" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffe9a8" stop-opacity=".5"/>
      <stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="st-floor" x1="0" y1="654" x2="0" y2="720" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6b4028"/>
      <stop offset="1" stop-color="#40241a"/>
    </linearGradient>
  </defs>
"""
    )
    # 顶部灯光
    for x in [150, 400, 640, 880, 1130]:
        s.append(f'  <path d="M{x - 70} 0 L{x + 70} 0 L{x + 130} 200 L{x - 130} 200 Z" fill="url(#st-light)"/>\n')
    # 幕布
    s.append(
        '  <path d="M0 0 L120 0 C 96 130, 132 240, 104 360 C 84 460, 110 560, 96 660 L0 660 Z" fill="#8e2b3c" opacity=".92"/>\n'
    )
    s.append(
        '  <path d="M1280 0 L1160 0 C 1184 130, 1148 240, 1176 360 C 1196 460, 1170 560, 1184 660 L1280 660 Z" fill="#8e2b3c" opacity=".92"/>\n'
    )
    for i in range(6):
        x = 18 + i * 17
        s.append(f'  <rect x="{x}" y="0" width="6" height="655" fill="#6f1f2e" opacity=".35"/>\n')
        s.append(f'  <rect x="{1240 - i * 17}" y="0" width="6" height="655" fill="#6f1f2e" opacity=".35"/>\n')
    # 舞台地板
    s.append('  <rect y="654" width="1280" height="66" fill="url(#st-floor)"/>\n')
    for _ in range(40):
        x = rnd.uniform(0, 1280)
        s.append(f'  <rect x="{x:.0f}" y="656" width="2" height="64" fill="#2b170f" opacity=".35"/>\n')
    s.append("</svg>\n")
    return "".join(s)


def space() -> str:
    rnd = random.Random(31)
    s = [head("space")]
    s.append(
        """  <defs>
    <linearGradient id="sp-sky" x1="0" y1="0" x2="0" y2="180" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0d1330" stop-opacity=".97"/>
      <stop offset="1" stop-color="#0d1330" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="sp-planet" cx=".35" cy=".3" r=".8">
      <stop offset="0" stop-color="#ffd27a"/>
      <stop offset="1" stop-color="#e8734a"/>
    </radialGradient>
  </defs>
"""
    )
    s.append('  <rect width="1280" height="180" fill="url(#sp-sky)"/>\n')
    for _ in range(110):
        x = rnd.uniform(0, 1280)
        y = rnd.uniform(4, 150)
        r = rnd.choice([0.8, 1.2, 1.6, 2.2])
        s.append(f'  <circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#ffffff" opacity="{rnd.uniform(0.35, 0.95):.2f}"/>\n')
    s.append('  <circle cx="1082" cy="62" r="42" fill="url(#sp-planet)" opacity=".9"/>\n')
    s.append('  <ellipse cx="1082" cy="62" rx="72" ry="14" fill="none" stroke="#ffd9a8" stroke-width="5" opacity=".7" transform="rotate(-16 1082 62)"/>\n')
    s.append(
        '  <path d="M0 690 C 260 664, 520 704, 780 686 C 1000 670, 1140 700, 1280 682 L1280 720 L0 720 Z" fill="#2a1f5c" opacity=".9"/>\n'
    )
    s.append("</svg>\n")
    return "".join(s)


FILES = {"garden": garden, "stadium": stadium, "stage": stage, "space": space}
for name, fn in FILES.items():
    path = os.path.join(OUT, name + ".svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(fn())
    print(name, os.path.getsize(path), "bytes")
