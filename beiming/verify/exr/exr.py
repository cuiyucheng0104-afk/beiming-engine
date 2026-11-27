"""单部件扫描线 EXR。通道为行优先的一维数列，读取时返回带类型的平面。"""
import struct
import sys
import zlib


_COMPONENTS = {
    'color': ('R', 'G', 'B', 'A'), 'depth': ('Z',), 'objectId': ('id', 'coverage'),
    'normal': ('X', 'Y', 'Z'), 'motion': ('X', 'Y'), 'denoiseAlbedo': ('R', 'G', 'B'),
    'denoiseNormal': ('X', 'Y', 'Z'),
    # 输出通道契约 3.1 的八个光路通道（可选）
    **{n: ('R', 'G', 'B') for n in ('diffuseDirect', 'diffuseIndirect', 'glossyDirect', 'glossyIndirect',
                                    'transmissionDirect', 'transmissionIndirect', 'emission', 'environment')},
}


def is_pass_channel(name):
    layer, _, component = name.rpartition('.')
    if layer in _COMPONENTS:
        return component in _COMPONENTS[layer]
    group = layer.partition(':')[2]
    allowed = 'abcdefghijklmnopqrstuvwxyz0123456789'
    return (layer.startswith('lightgroup:') and bool(group) and group[0] in allowed
            and all(c in allowed + '-' for c in group) and component in ('R', 'G', 'B'))


def _check(condition, message):
    if not condition:
        raise ValueError('EXR: ' + message)


def _word(n):
    return struct.pack('<i', n)


def _text(name):
    return name.encode('ascii') + b'\0'


def _attr(name, kind, data):
    return _text(name) + _text(kind) + _word(len(data)) + data


def _zip(row):
    shuffled = row[::2] + row[1::2]
    delta = bytes((b - a + 128) & 255 for a, b in zip(shuffled, shuffled[1:]))
    packed = zlib.compress(shuffled[:1] + delta)
    return packed if len(packed) < len(row) else row


def _unzip(data, size):
    decoder = zlib.decompressobj()
    delta = bytearray(decoder.decompress(data, size + 1))
    _check(len(delta) == size and decoder.eof, '无效压缩行')
    for i in range(1, size):
        delta[i] = (delta[i] + delta[i - 1] - 128) & 255
    row = bytearray(size)
    row[::2], row[1::2] = delta[:size // 2], delta[size // 2:]
    return row


def _endian(data):
    if sys.byteorder == 'little':
        return data
    return b''.join(bytes(data[i:i + 4])[::-1] for i in range(0, len(data), 4))


def write_exr(width, height, channels, compression=0):
    _check(all(isinstance(n, int) and not isinstance(n, bool) and 0 < n <= 0x7fffffff for n in (width, height)), '无效尺寸')
    _check(compression in (0, 2) and channels, '压缩或通道表无效')
    entries, planes = [], []
    for name in sorted(channels):
        _check(0 < len(name) <= 255 and all(32 <= ord(c) <= 126 for c in name), '无效通道名')
        values = channels[name]
        _check(len(values) == width * height, '通道尺寸不符 ' + name)
        unsigned = name == 'objectId.id' or getattr(values, 'format', None) == 'I' or getattr(values, 'typecode', None) == 'I'
        fmt = 'I' if unsigned else 'f'
        _check(not is_pass_channel(name) or unsigned == (name == 'objectId.id'), '通道类型不符 ' + name)
        if isinstance(values, memoryview) and values.format == fmt:
            plane = _endian(values.cast('B'))
        else:
            plane = struct.pack('<%d%s' % (len(values), fmt), *values)
        planes.append(plane)
        entries.append(_text(name) + struct.pack('<i4xii', 0 if unsigned else 2, 1, 1))
    window = struct.pack('<4i', 0, 0, width - 1, height - 1)
    header = b''.join([
        _word(20000630), _word(0x402 if any(len(n) > 31 for n in channels) else 2),
        _attr('channels', 'chlist', b''.join(entries) + b'\0'),
        _attr('compression', 'compression', bytes([compression])), _attr('dataWindow', 'box2i', window),
        _attr('displayWindow', 'box2i', window), _attr('lineOrder', 'lineOrder', b'\0'),
        _attr('pixelAspectRatio', 'float', struct.pack('<f', 1)), _attr('screenWindowCenter', 'v2f', bytes(8)),
        _attr('screenWindowWidth', 'float', struct.pack('<f', 1)), b'\0',
    ])
    offsets, chunks = bytearray(8 * height), bytearray()
    for y in range(height):
        struct.pack_into('<Q', offsets, 8 * y, len(header) + len(offsets) + len(chunks))
        row = b''.join(p[y * width * 4:(y + 1) * width * 4] for p in planes)
        payload = _zip(row) if compression == 2 else row
        chunks.extend(struct.pack('<ii', y, len(payload)))
        chunks.extend(payload)
    return header + offsets + chunks


class _Cursor:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def take(self, size):
        _check(0 <= size <= len(self.data) - self.pos, '数据截断')
        self.pos += size
        return self.data[self.pos - size:self.pos]

    def word(self):
        return struct.unpack('<i', self.take(4))[0]

    def name(self):
        end = self.data.find(b'\0', self.pos, self.pos + 256)
        _check(end >= self.pos, '无效名称')
        return self.take(end + 1 - self.pos)[:-1].decode()


def read_exr(data, required_channels=()):
    cursor = _Cursor(bytes(data))
    _check(cursor.word() == 20000630 and cursor.word() in (2, 0x402), '仅支持单部件扫描线 v2')
    attrs = {}
    while name := cursor.name():
        _check(name not in attrs, '重复属性 ' + name)
        attrs[name] = (cursor.name(), cursor.take(cursor.word()))

    def attr(name, kind):
        _check(name in attrs and attrs[name][0] == kind, '无效属性 ' + name)
        return attrs[name][1]

    for key, kind, size in [('displayWindow', 'box2i', 16), ('pixelAspectRatio', 'float', 4),
                            ('screenWindowCenter', 'v2f', 8), ('screenWindowWidth', 'float', 4)]:
        _check(len(attr(key, kind)) == size, '无效属性 ' + key)
    _check(attr('lineOrder', 'lineOrder') in (b'\x00', b'\x01'), '无效扫描线顺序')
    xmin, ymin, xmax, ymax = struct.unpack('<4i', attr('dataWindow', 'box2i'))
    width, height = xmax - xmin + 1, ymax - ymin + 1
    compression, = struct.unpack('B', attr('compression', 'compression'))
    _check(width > 0 and height > 0 and compression in (0, 2), '压缩或窗口无效')
    listing = _Cursor(attr('channels', 'chlist'))
    formats = {}
    while name := listing.name():
        kind, xs, ys = struct.unpack('<i4xii', listing.take(16))
        _check(kind in (0, 2) and xs == ys == 1 and name not in formats, '无效通道 ' + name)
        formats[name] = 'f' if kind == 2 else 'I'
    _check(formats and listing.pos == len(listing.data), '无效通道表')
    for name in required_channels:
        _check(name in formats, '缺少通道 ' + name)
    offsets = cursor.take(8 * height)
    start = cursor.pos
    planes = {name: bytearray() for name in formats}
    stride = width * 4
    size = len(formats) * stride
    for y, (offset,) in enumerate(struct.iter_unpack('<Q', offsets)):
        cursor.pos = offset
        _check(offset >= start and cursor.word() == y + ymin, '扫描线偏移或行号无效')
        row = cursor.take(cursor.word())
        if len(row) != size:
            _check(compression == 2 and len(row) < size, '扫描线长度不符')
            row = _unzip(row, size)
        for i, plane in enumerate(planes.values()):
            plane.extend(row[i * stride:(i + 1) * stride])
    channels = {n: memoryview(_endian(p)).cast(formats[n]) for n, p in planes.items()}
    return dict(width=width, height=height, channels=channels, compression=compression)


if __name__ == '__main__':
    # 二进制管道往返，命令行参数是读入时必需的通道名。
    image = read_exr(sys.stdin.buffer.read(), sys.argv[1:])
    sys.stdout.buffer.write(write_exr(**image))
