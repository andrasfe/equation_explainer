// Renders the app icon (a little chalkboard) to a 1024px PNG.  swift scripts/make_icon.swift out.png
import AppKit

let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// wooden frame
let outer = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 180, yRadius: 180)
NSGradient(colors: [NSColor(red: 0.62, green: 0.42, blue: 0.25, alpha: 1), NSColor(red: 0.33, green: 0.21, blue: 0.11, alpha: 1)])!
    .draw(in: outer, angle: -90)
// slate
let inner = NSBezierPath(roundedRect: NSRect(x: 128, y: 128, width: 768, height: 768), xRadius: 120, yRadius: 120)
NSGradient(colors: [NSColor(red: 0.20, green: 0.27, blue: 0.23, alpha: 1), NSColor(red: 0.10, green: 0.14, blue: 0.12, alpha: 1)])!
    .draw(in: inner, angle: -90)
// chalk smudge
ctx.saveGState()
inner.addClip()
let smudge = NSGradient(colors: [NSColor(white: 1, alpha: 0.10), NSColor(white: 1, alpha: 0)])!
smudge.draw(fromCenter: NSPoint(x: 380, y: 640), radius: 0, toCenter: NSPoint(x: 380, y: 640), radius: 380, options: [])
ctx.restoreGState()

func chalk(_ s: String, _ font: String, _ pt: CGFloat, _ color: NSColor, at p: NSPoint) {
    let shadow = NSShadow(); shadow.shadowColor = color.withAlphaComponent(0.5); shadow.shadowBlurRadius = 10
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont(name: font, size: pt) ?? NSFont.systemFont(ofSize: pt),
                                                 .foregroundColor: color, .shadow: shadow]
    NSAttributedString(string: s, attributes: attrs).draw(at: p)
}
chalk("∂ψ", "Chalkduster", 300, NSColor(red: 0.95, green: 0.94, blue: 0.90, alpha: 1), at: NSPoint(x: 205, y: 360))
chalk("|0⟩", "Chalkduster", 130, NSColor(red: 0.96, green: 0.88, blue: 0.54, alpha: 1), at: NSPoint(x: 520, y: 200))
// a chalk circle + arrow, the app's signature gesture
let loop = NSBezierPath(ovalIn: NSRect(x: 490, y: 175, width: 330, height: 190))
loop.lineWidth = 14
NSColor(red: 0.95, green: 0.65, blue: 0.71, alpha: 0.9).setStroke()
loop.stroke()
img.unlockFocus()

let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
