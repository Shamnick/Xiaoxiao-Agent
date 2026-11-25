import AppKit
import CoreGraphics

let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ rgb: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
            blue: CGFloat(rgb & 255) / 255, alpha: alpha)
}

func paint(_ canvas: CGContext, _ colors: [CGColor], from start: CGPoint, to end: CGPoint) {
    let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil)!
    canvas.drawLinearGradient(gradient, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func plate(_ inset: CGFloat) -> CGPath {
    let p = CGMutablePath()
    let a: CGFloat = 29, b: CGFloat = 483, k: CGFloat = 124, j: CGFloat = 388, c: CGFloat = 69, d: CGFloat = 443
    p.move(to: CGPoint(x: k, y: a))
    p.addLine(to: CGPoint(x: j, y: a))
    p.addCurve(to: CGPoint(x: b, y: k), control1: CGPoint(x: d, y: a), control2: CGPoint(x: b, y: c))
    p.addLine(to: CGPoint(x: b, y: j))
    p.addCurve(to: CGPoint(x: j, y: b), control1: CGPoint(x: b, y: d), control2: CGPoint(x: d, y: b))
    p.addLine(to: CGPoint(x: k, y: b))
    p.addCurve(to: CGPoint(x: a, y: j), control1: CGPoint(x: c, y: b), control2: CGPoint(x: a, y: d))
    p.addLine(to: CGPoint(x: a, y: k))
    p.addCurve(to: CGPoint(x: k, y: a), control1: CGPoint(x: a, y: c), control2: CGPoint(x: c, y: a))
    p.closeSubpath()
    let scale = (512 - 2 * inset) / 512
    var t = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: inset, ty: inset)
    return p.copy(using: &t)!
}

// A single folded X. Draw the broad faces first so that
// the bridge remains clear at 16 points. Coordinates below are in a 512pt sketch.
func drawFold(_ ctx: CGContext) {
    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
    func face(_ shades: [UInt32], _ start: CGPoint, _ end: CGPoint, _ trace: (CGMutablePath) -> Void) {
        let path = CGMutablePath()
        trace(path)
        path.closeSubpath()
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        paint(ctx, shades.map { color($0) }, from: start, to: end)
        ctx.restoreGState()
    }
    // Lower face folds into the right-hand tip.
    face([0x3b339a, 0x4b52d8, 0x637cff], pt(240,230), pt(375,382)) { p in
        p.move(to: pt(113,121))
        p.addQuadCurve(to: pt(149,114), control: pt(126,100))
        p.addCurve(to: pt(317,268), control1: pt(212,143), control2: pt(276,219))
        p.addQuadCurve(to: pt(390,354), control: pt(356,315))
        p.addQuadCurve(to: pt(379,383), control: pt(408,380))
        p.addCurve(to: pt(292,346), control1: pt(354,386), control2: pt(319,370))
        p.addLine(to: pt(176,217))
        p.addLine(to: pt(113,121))
    }
    // Rolled upper-left edge, with a sharp glint along the join.
    face([0xc3baff,0x8178f1,0x5949bc], pt(112,110), pt(242,252)) { p in
        p.move(to: pt(110,122))
        p.addQuadCurve(to: pt(143,130), control: pt(118,108))
        p.addCurve(to: pt(240,226), control1: pt(173,147), control2: pt(210,187))
        p.addLine(to: pt(216,257))
        p.addQuadCurve(to: pt(123,175), control: pt(156,212))
        p.addQuadCurve(to: pt(110,122), control: pt(101,148))
    }
    // Front sweep is cut from one band. Its slow curve gathers at the crossing.
    face([0x434ab7,0x8a68ed,0xf1a4ae], pt(110,362), pt(378,109)) { p in
        p.move(to: pt(110,360))
        p.addCurve(to: pt(180,269), control1: pt(109,337), control2: pt(141,303))
        p.addCurve(to: pt(284,172), control1: pt(222,231), control2: pt(254,207))
        p.addCurve(to: pt(378,103), control1: pt(324,131), control2: pt(354,101))
        p.addQuadCurve(to: pt(393,134), control: pt(398,100))
        p.addCurve(to: pt(335,218), control1: pt(390,161), control2: pt(358,196))
        p.addCurve(to: pt(211,326), control1: pt(302,247), control2: pt(247,294))
        p.addQuadCurve(to: pt(126,390), control: pt(159,376))
        p.addQuadCurve(to: pt(110,360), control: pt(105,397))
    }
    // Both returns are continuous along the outer edge, with open space at their tips.
    face([0xffcb97,0xec879f,0x8a62d9], pt(388,105), pt(277,240)) { p in
        p.move(to: pt(376,103))
        p.addQuadCurve(to: pt(395,127), control: pt(394,99))
        p.addCurve(to: pt(362,204), control1: pt(402,154), control2: pt(381,184))
        p.addQuadCurve(to: pt(308,248), control: pt(343,226))
        p.addLine(to: pt(279,221))
        p.addQuadCurve(to: pt(357,163), control: pt(331,192))
        p.addQuadCurve(to: pt(376,103), control: pt(389,128))
    }
    face([0x4f64ef,0x738df7,0xa89ef5], pt(122,394), pt(233,285)) { p in
        p.move(to: pt(110,359))
        p.addQuadCurve(to: pt(125,376), control: pt(111,377))
        p.addCurve(to: pt(215,313), control1: pt(150,366), control2: pt(191,333))
        p.addLine(to: pt(245,288))
        p.addLine(to: pt(219,337))
        p.addCurve(to: pt(133,399), control1: pt(183,373), control2: pt(147,399))
        p.addQuadCurve(to: pt(110,359), control: pt(108,402))
    }
}

func drawIcon(_ size: Int, markOnly: Bool = false, to url: URL) throws {
    let canvas = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                           space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let scale = CGFloat(size) / 512
    canvas.scaleBy(x: scale, y: scale)
    canvas.translateBy(x: 0, y: 512)
    canvas.scaleBy(x: 1, y: -1)
    if !markOnly {
        let outline = plate(0)
        canvas.addPath(outline)
        canvas.clip()
        paint(canvas, [color(0xf8faff),color(0xf0f1ff),color(0xd4d9ef)], from: CGPoint(x: 130,y: 35), to: CGPoint(x: 390,y: 486))
        canvas.addPath(outline)
        canvas.setStrokeColor(color(0x8994b7, alpha: 0.38))
        canvas.setLineWidth(3)
        canvas.strokePath()
    }
    let zoom: CGFloat = markOnly ? 1.60 : size <= 32 ? 1.14 : 1.05
    canvas.translateBy(x: 256 * (1-zoom), y: 256 * (1-zoom))
    canvas.scaleBy(x: zoom, y: zoom)
    if !markOnly && size >= 64 {
        canvas.setShadow(offset: CGSize(width: 0, height: -4), blur: 7, color: color(0x38366c, alpha: 0.19))
    }
    canvas.beginTransparencyLayer(auxiliaryInfo: nil)
    drawFold(canvas)
    canvas.endTransparencyLayer()
    let bitmap = NSBitmapImageRep(cgImage: canvas.makeImage()!)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url, options: .atomic)
}

let folder = URL(fileURLWithPath: "build/icon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try drawIcon(size * scale, to: folder.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
try drawIcon(512, to: URL(fileURLWithPath: "src/brand.png"))
try drawIcon(192, markOnly: true, to: URL(fileURLWithPath: "src/brand-mark.png"))
