import sharp from 'sharp'

interface TitleParams {
  titleColor?: string
  fontSize?: number
  titleAlignment?: 'top' | 'middle' | 'bottom'
  fontStyle?: string
  fontUnderline?: boolean
}

export async function renderTitle(size: number, title: string, params: TitleParams = {}): Promise<Uint8Array> {
  const color = params.titleColor ?? '#ffffff'
  const fontSize = params.fontSize ?? Math.round(size / 5)
  const align = params.titleAlignment ?? 'bottom'

  const yPos: Record<string, string> = { top: '20%', middle: '50%', bottom: '82%' }
  const baseline: Record<string, string> = { top: 'hanging', middle: 'middle', bottom: 'auto' }

  const fontWeight = params.fontStyle?.includes('Bold') ? 'bold' : 'normal'
  const fontStyleAttr = params.fontStyle?.includes('Italic') ? 'italic' : 'normal'

  const escaped = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="black"/>
    <text x="50%" y="${yPos[align]}" text-anchor="middle" dominant-baseline="${baseline[align]}"
          fill="${color}" font-size="${fontSize}px" font-family="DejaVu Sans,Arial,sans-serif"
          font-weight="${fontWeight}" font-style="${fontStyleAttr}">${escaped}</text>
  </svg>`

  return sharp(Buffer.from(svg)).resize(size, size).removeAlpha().raw().toBuffer()
}

export async function renderBlack(size: number): Promise<Uint8Array> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .raw()
    .toBuffer()
}
