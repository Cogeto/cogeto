import { fmt } from './pdf-writer';

/**
 * Renders the canonical Cogeto logo SVG (assets/brand, trademarked) into PDF
 * path operators — a faithful FORMAT conversion of the provided file, never a
 * redrawing: every path, transform, stroke width and colour comes from the
 * SVG's own attributes. Supports exactly what the brand files use: <g> with
 * translate/scale, <path> (M L H V C Q A Z, absolute or relative), <circle>,
 * fill, stroke, stroke-width, round line caps.
 */

export interface ParsedLogo {
  viewBox: { width: number; height: number };
  /** Operators drawing the logo into a unit space where the viewBox maps to
   * (0,0)-(width,height) with the PDF's y-up axis already handled. Callers
   * wrap in q/cm/Q to place and scale. */
  operators: string;
}

interface GroupState {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  transforms: string[];
}

export function parseLogoSvg(svg: string): ParsedLogo {
  const viewBoxMatch = svg.match(/viewBox="([\d.\s-]+)"/);
  if (!viewBoxMatch) throw new Error('logo svg has no viewBox');
  const [, , width, height] = viewBoxMatch[1]!.trim().split(/\s+/).map(Number);
  if (!width || !height) throw new Error('logo svg viewBox is degenerate');

  const ops: string[] = [];
  // The svg y-axis points down; flip it once around the viewBox height.
  ops.push(`1 0 0 -1 0 ${fmt(height)} cm`);

  const tagRe = /<(g|path|circle|\/g)([^>]*?)\/?>/g;
  const stack: GroupState[] = [{ fill: null, stroke: null, strokeWidth: 1, transforms: [] }];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(svg)) !== null) {
    const tag = match[1]!;
    const attrs = match[2] ?? '';
    const state = stack[stack.length - 1]!;
    if (tag === 'g') {
      stack.push({
        fill: attr(attrs, 'fill') ?? state.fill,
        stroke: attr(attrs, 'stroke') ?? state.stroke,
        strokeWidth: numAttr(attrs, 'stroke-width') ?? state.strokeWidth,
        transforms: [...state.transforms, ...parseTransforms(attr(attrs, 'transform'))],
      });
      continue;
    }
    if (tag === '/g') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const fill = attr(attrs, 'fill') ?? state.fill;
    const stroke = attr(attrs, 'stroke') ?? state.stroke;
    const strokeWidth = numAttr(attrs, 'stroke-width') ?? state.strokeWidth;
    const transforms = [...state.transforms, ...parseTransforms(attr(attrs, 'transform'))];

    const body: string[] = [];
    if (tag === 'circle') {
      const cx = numAttr(attrs, 'cx') ?? 0;
      const cy = numAttr(attrs, 'cy') ?? 0;
      const r = numAttr(attrs, 'r') ?? 0;
      body.push(circlePath(cx, cy, r));
    } else {
      const d = attr(attrs, 'd');
      if (!d) continue;
      body.push(pathData(d));
    }

    const paint: string[] = [];
    const fillColor = color(fill);
    const strokeColor = color(stroke);
    if (strokeColor) {
      paint.push(`${strokeColor.join(' ')} RG ${fmt(strokeWidth)} w 1 J 1 j`);
    }
    if (fillColor) paint.push(`${fillColor.join(' ')} rg`);
    const painter = fillColor && strokeColor ? 'B' : strokeColor ? 'S' : fillColor ? 'f' : 'n';
    ops.push(['q', ...transforms, ...paint, ...body, painter, 'Q'].join('\n'));
  }
  return { viewBox: { width, height }, operators: ops.join('\n') };
}

function attr(attrs: string, name: string): string | null {
  const found = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return found ? found[1]! : null;
}

function numAttr(attrs: string, name: string): number | null {
  const raw = attr(attrs, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function color(value: string | null): [string, string, string] | null {
  if (!value || value === 'none') return null;
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (!hex) return null;
  const n = parseInt(hex[1]!, 16);
  return [fmt(((n >> 16) & 0xff) / 255), fmt(((n >> 8) & 0xff) / 255), fmt((n & 0xff) / 255)];
}

function parseTransforms(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /(translate|scale)\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const args = match[2]!
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (match[1] === 'translate') {
      out.push(`1 0 0 1 ${fmt(args[0] ?? 0)} ${fmt(args[1] ?? 0)} cm`);
    } else {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      out.push(`${fmt(sx)} 0 0 ${fmt(sy)} 0 0 cm`);
    }
  }
  return out;
}

/** A circle as four bezier arcs (the standard kappa construction). */
function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  return [
    `${fmt(cx + r)} ${fmt(cy)} m`,
    `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c`,
    `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c`,
    `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c`,
    `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c`,
  ].join('\n');
}

/** SVG path data → PDF path construction operators. */
function pathData(d: string): string {
  const out: string[] = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) ?? [];
  let i = 0;
  let command = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const read = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      i += 1;
      // Z takes no arguments; handle immediately (and repeatable commands
      // below consume arguments until the next letter).
      if (command === 'Z' || command === 'z') {
        out.push('h');
        x = startX;
        y = startY;
      }
      continue;
    }
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case 'M': {
        const nx = read() + (relative ? x : 0);
        const ny = read() + (relative ? y : 0);
        out.push(`${fmt(nx)} ${fmt(ny)} m`);
        x = nx;
        y = ny;
        startX = nx;
        startY = ny;
        // Subsequent pairs are implicit linetos.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const nx = read() + (relative ? x : 0);
        const ny = read() + (relative ? y : 0);
        out.push(`${fmt(nx)} ${fmt(ny)} l`);
        x = nx;
        y = ny;
        break;
      }
      case 'H': {
        const nx = read() + (relative ? x : 0);
        out.push(`${fmt(nx)} ${fmt(y)} l`);
        x = nx;
        break;
      }
      case 'V': {
        const ny = read() + (relative ? y : 0);
        out.push(`${fmt(x)} ${fmt(ny)} l`);
        y = ny;
        break;
      }
      case 'C': {
        const x1 = read() + (relative ? x : 0);
        const y1 = read() + (relative ? y : 0);
        const x2 = read() + (relative ? x : 0);
        const y2 = read() + (relative ? y : 0);
        const nx = read() + (relative ? x : 0);
        const ny = read() + (relative ? y : 0);
        out.push(`${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(nx)} ${fmt(ny)} c`);
        x = nx;
        y = ny;
        break;
      }
      case 'Q': {
        // Quadratic → cubic (exact conversion).
        const qx = read() + (relative ? x : 0);
        const qy = read() + (relative ? y : 0);
        const nx = read() + (relative ? x : 0);
        const ny = read() + (relative ? y : 0);
        const c1x = x + (2 / 3) * (qx - x);
        const c1y = y + (2 / 3) * (qy - y);
        const c2x = nx + (2 / 3) * (qx - nx);
        const c2y = ny + (2 / 3) * (qy - ny);
        out.push(`${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(nx)} ${fmt(ny)} c`);
        x = nx;
        y = ny;
        break;
      }
      case 'A': {
        const rx = read();
        const ry = read();
        const rotation = read();
        const largeArc = read();
        const sweep = read();
        const nx = read() + (relative ? x : 0);
        const ny = read() + (relative ? y : 0);
        for (const segment of arcToCubics(
          x,
          y,
          rx,
          ry,
          rotation,
          largeArc !== 0,
          sweep !== 0,
          nx,
          ny,
        )) {
          out.push(
            `${fmt(segment[0])} ${fmt(segment[1])} ${fmt(segment[2])} ${fmt(segment[3])} ${fmt(
              segment[4],
            )} ${fmt(segment[5])} c`,
          );
        }
        x = nx;
        y = ny;
        break;
      }
      default:
        // An unsupported command would mean the brand file changed shape;
        // fail loudly rather than draw a wrong logo.
        throw new Error(`logo svg uses unsupported path command '${command}'`);
    }
  }
  return out.join('\n');
}

/** SVG endpoint arc → center parameterization → cubic segments (SVG F.6.5). */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): [number, number, number, number, number, number][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [];
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const out: [number, number, number, number, number, number][] = [];
  const step = delta / segments;
  for (let s = 0; s < segments; s += 1) {
    const t1 = theta1 + s * step;
    const t2 = t1 + step;
    const alpha = (4 / 3) * Math.tan((t2 - t1) / 4);
    const point = (t: number): [number, number] => [
      cx + rx * Math.cos(phi) * Math.cos(t) - ry * Math.sin(phi) * Math.sin(t),
      cy + rx * Math.sin(phi) * Math.cos(t) + ry * Math.cos(phi) * Math.sin(t),
    ];
    const derivative = (t: number): [number, number] => [
      -rx * Math.cos(phi) * Math.sin(t) - ry * Math.sin(phi) * Math.cos(t),
      -rx * Math.sin(phi) * Math.sin(t) + ry * Math.cos(phi) * Math.cos(t),
    ];
    const [p1x, p1y] = point(t1);
    const [p2x, p2y] = point(t2);
    const [d1x, d1y] = derivative(t1);
    const [d2x, d2y] = derivative(t2);
    out.push([
      p1x + alpha * d1x,
      p1y + alpha * d1y,
      p2x - alpha * d2x,
      p2y - alpha * d2y,
      p2x,
      p2y,
    ]);
  }
  return out;
}
