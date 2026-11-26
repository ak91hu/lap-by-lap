// Elhelyezés-pontos képelőkészítés: a PDF-be pontosan annyi pixel kerül, amennyi a nyomtatott
// mérethez kell (nyomda: 300 DPI, képernyő: 150 DPI). Ez nagyságrenddel kisebb PDF-et és kevesebb
// memóriát jelent, mint az eredeti képek beágyazása.
import sharp from 'sharp';

export class ImagePrep {
  constructor({ dpi = 300, quality = 86 } = {}) {
    this.dpi = dpi;
    this.quality = quality;
  }

  px(pt) {
    return Math.max(1, Math.round((pt / 72) * this.dpi));
  }

  /** Arányos elhelyezés (a layout már a képarányhoz igazodik). Visszaad: Buffer vagy az eredeti fájlútvonal. */
  async fit(file, srcW, wPt, hPt) {
    const tw = this.px(wPt);
    const th = this.px(hPt);
    if (srcW <= tw * 1.15) return file; // nincs értelme átméretezni (a PDFKit az EXIF-forgatást kezeli)
    return sharp(file)
      .rotate()
      .resize(tw, th, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: this.quality }) // libjpeg-turbo: többszörösen gyorsabb a mozjpeg-nél
      .toBuffer();
  }

  /** Kitöltő (vágott) elhelyezés intelligens kivágással – borító, kifutó képek, sávok. */
  async cover(file, wPt, hPt) {
    return sharp(file)
      .rotate()
      .resize(this.px(wPt), this.px(hPt), { fit: 'cover', position: sharp.strategy.attention })
      .jpeg({ quality: this.quality })
      .toBuffer();
  }

  /** Kör alakú profilképhez. */
  async square(file, sizePt) {
    return this.cover(file, sizePt, sizePt);
  }
}
