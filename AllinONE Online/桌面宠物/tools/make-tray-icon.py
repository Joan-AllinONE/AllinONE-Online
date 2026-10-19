"""生成桌宠托盘图标（assets/tray.png）。

纯标准库实现（zlib + struct），无需安装 Pillow。
用法：python tools/make-tray-icon.py
输出：64x64 托盘主图标，并在控制台打印 16x16 版本 base64（供 Electron 兜底内联）。
"""
import base64
import os
import struct
import zlib

# 归一化坐标系（0~1）下的小猫头像
ORANGE = (255, 159, 67, 255)
ORANGE_DARK = (240, 138, 46, 255)
EYE = (61, 61, 61, 255)
HILIGHT = (255, 255, 255, 255)
BLUSH = (255, 158, 158, 190)
NOSE = (232, 112, 95, 255)

HEAD = (0.5, 0.58, 0.36, 0.36)    # 头部：椭圆 cx, cy, rx, ry
EAR_L = ((0.17, 0.10), (0.44, 0.31), (0.14, 0.44))
EAR_R = ((0.83, 0.10), (0.56, 0.31), (0.86, 0.44))
EYE_L = (0.365, 0.545, 0.052, 0.078)
EYE_R = (0.635, 0.545, 0.052, 0.078)
HILIGHT_L = (0.382, 0.518, 0.020, 0.026)
HILIGHT_R = (0.652, 0.518, 0.020, 0.026)
BLUSH_L = (0.255, 0.655, 0.068, 0.042)
BLUSH_R = (0.745, 0.655, 0.068, 0.042)
NOSE_T = ((0.470, 0.615), (0.530, 0.615), (0.500, 0.648))


def blend(dst, src):
    sa = src[3] / 255.0
    if sa <= 0:
        return dst
    da = dst[3] / 255.0
    oa = sa + da * (1 - sa)
    if oa <= 0:
        return (0, 0, 0, 0)
    r = (src[0] * sa + dst[0] * da * (1 - sa)) / oa
    g = (src[1] * sa + dst[1] * da * (1 - sa)) / oa
    b = (src[2] * sa + dst[2] * da * (1 - sa)) / oa
    return (int(r), int(g), int(b), int(oa * 255))


def in_ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def pixel(u, v):
    """返回归一化坐标 (u,v) 处的颜色；自下而上分层绘制。"""
    col = (0, 0, 0, 0)
    if in_triangle(u, v, *EAR_L) or in_triangle(u, v, *EAR_R):
        col = blend(col, ORANGE_DARK)
    if in_ellipse(u, v, *HEAD):
        col = blend(col, ORANGE)
    if in_ellipse(u, v, *BLUSH_L) or in_ellipse(u, v, *BLUSH_R):
        col = blend(col, BLUSH)
    if in_ellipse(u, v, *EYE_L) or in_ellipse(u, v, *EYE_R):
        col = blend(col, EYE)
    if in_ellipse(u, v, *HILIGHT_L) or in_ellipse(u, v, *HILIGHT_R):
        col = blend(col, HILIGHT)
    if in_triangle(u, v, *NOSE_T):
        col = blend(col, NOSE)
    return col


def render(size, ss=4):
    """超采样抗锯齿渲染，返回 RGBA 字节序列。"""
    rows = bytearray()
    inv = 1.0 / ss
    for y in range(size):
        rows.append(0)  # filter type 0
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) * inv) / size
                    v = (y + (sy + 0.5) * inv) / size
                    c = pixel(u, v)
                    r += c[0]
                    g += c[1]
                    b += c[2]
                    a += c[3]
            n = ss * ss
            rows += bytes((r // n, g // n, b // n, a // n))
    return bytes(rows)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def png(size, ss=4):
    raw = render(size, ss)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(here, 'assets')
    os.makedirs(out_dir, exist_ok=True)

    big = png(64, 4)
    with open(os.path.join(out_dir, 'tray.png'), 'wb') as f:
        f.write(big)
    print('written: %s (%d bytes)' % (os.path.join(out_dir, 'tray.png'), len(big)))

    small = png(16, 5)
    with open(os.path.join(out_dir, 'tray-16.png'), 'wb') as f:
        f.write(small)

    print('BASE64_16_BEGIN')
    print(base64.b64encode(small).decode('ascii'))
    print('BASE64_16_END')


if __name__ == '__main__':
    main()
