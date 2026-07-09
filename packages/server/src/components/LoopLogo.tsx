import type { CSSProperties } from 'react'

/**
 * Brand mark: ONE Rubik's cube spelling L-O-O-P. Each of the four side faces
 * draws a letter with its 3x3 stickers (e.g. L = left column + bottom row); the
 * cube spins on the Y axis so a full turn reveals L → O → O → P. Each letter
 * rides one classic Rubik hue; the top/bottom caps carry the other two. The 3D
 * geometry + spin keyframes live in app.css.
 *
 * `size` is the cube edge length in px.
 */

// 3x3 sticker maps, row-major (index 0 = top-left, 8 = bottom-right). A `1`
// means that sticker is lit with the face color; `0` is dark plastic.
//   L           O           O           P
//   X . .       X X X       X X X       X X X
//   X . .       X . X       X . X       X X X
//   X X X       X X X       X X X       X . .
const L = [1, 0, 0, 1, 0, 0, 1, 1, 1]
const O = [1, 1, 1, 1, 0, 1, 1, 1, 1]
const P = [1, 1, 1, 1, 1, 1, 1, 0, 0]

// The four side faces, in spin order (front → right → back → left), each with
// its letter map and classic Rubik hue.
const SIDES: Array<{ rot: string; map: number[]; on: string }> = [
  { rot: 'rotateY(0deg)', map: L, on: '#D71921' }, // red
  { rot: 'rotateY(90deg)', map: O, on: '#0051BA' }, // blue
  { rot: 'rotateY(180deg)', map: O, on: '#F5C518' }, // yellow
  { rot: 'rotateY(-90deg)', map: P, on: '#009E60' }, // green
]

// Caps complete the cube with the remaining two classic colors. `9` = all lit.
const FULL = [1, 1, 1, 1, 1, 1, 1, 1, 1]
const CAPS: Array<{ rot: string; on: string }> = [
  { rot: 'rotateX(90deg)', on: '#ededed' }, // top — white
  { rot: 'rotateX(-90deg)', on: '#ff5800' }, // bottom — orange
]

function Face({ rot, map, on, half }: { rot: string; map: number[]; on: string; half: string }) {
  return (
    <div
      className="loop-face"
      style={{ transform: `${rot} translateZ(${half})`, ['--on' as string]: on } as CSSProperties}
    >
      {map.map((cell, i) => (
        <span key={i} className="loop-cell" data-on={cell} />
      ))}
    </div>
  )
}

export function LoopLogo({ size = 56 }: { size?: number }) {
  const half = `${size / 2}px`
  return (
    <div
      className="loop-logo"
      style={{ ['--loop-s' as string]: `${size}px` } as CSSProperties}
      role="img"
      aria-label="adScaile"
    >
      <div className="loop-cube" aria-hidden>
        {SIDES.map((s, i) => (
          <Face key={i} rot={s.rot} map={s.map} on={s.on} half={half} />
        ))}
        {CAPS.map((c, i) => (
          <Face key={`cap${i}`} rot={c.rot} map={FULL} on={c.on} half={half} />
        ))}
      </div>
    </div>
  )
}
