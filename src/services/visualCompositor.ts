import { blendCode, type Adjustments, type FxSettings, type BlendMode, type LayerMask } from '../types/visual'

/*
 * WebGL compositor for layered image / video cues.
 *
 * One full-screen pass per visible layer, ping-ponging between two framebuffers: the fragment shader samples the
 * picture so far (the backdrop) and the layer's texture, applies the layer's transform, colour adjustments, mask and
 * blend mode, and writes the result. A last pass applies the whole-picture grading and the effects (grain, glow,
 * film, vignette, glitch) straight to the canvas. Everything runs on the GPU, so it keeps up with the display's
 * refresh rate on phones; nothing here ever touches the media files.
 */

export interface RenderLayer {
  /** Texture cache key (usually the source address). */
  key: string
  solid: boolean
  color: [number, number, number]
  source: TexImageSource | null
  width: number
  height: number
  /** Re-upload every frame (a playing video). */
  dynamic: boolean
  opacity: number
  blend: BlendMode
  x: number
  y: number
  scale: number
  rotation: number
  mask: LayerMask | null
  adjust: Adjustments
}

export interface RenderSpec {
  layers: RenderLayer[]
  adjust: Adjustments
  fx: FxSettings
  /** Seconds, drives the animated effects. */
  time: number
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 adjustColor(vec3 c, vec4 a, vec4 b) {
  c *= exp2(a.x * 2.0);
  c += a.y * 0.5;
  c = (c - 0.5) * (1.0 + a.z) + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + a.w);
  c.r += b.x * 0.15; c.b -= b.x * 0.15;
  c.g -= b.y * 0.10; c.r += b.y * 0.05; c.b += b.y * 0.05;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += b.w * 0.30 * (1.0 - smoothstep(0.0, 0.5, lum));
  c += b.z * 0.30 * smoothstep(0.5, 1.0, lum);
  return clamp(c, 0.0, 1.0);
}
`

const LAYER_FRAG = `${COMMON}
uniform sampler2D uBack;
uniform sampler2D uTex;
uniform float uCanvasAspect;
uniform vec2 uCenter;
uniform vec2 uBox;
uniform float uAngle;
uniform float uOpacity;
uniform int uBlend;
uniform float uSolid;
uniform vec3 uColor;
uniform vec4 uAdjA;
uniform vec4 uAdjB;
uniform int uMaskType;
uniform vec4 uMaskA;
uniform vec4 uMaskB;
uniform float uFeather;
uniform float uInvert;
uniform vec2 uPolyA[8];
uniform vec2 uPolyB[8];
uniform int uPolyN;

vec3 blendRGB(int mode, vec3 b, vec3 s) {
  if (mode == 1) return b * s;
  if (mode == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (mode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 4) return min(b + s, 1.0);
  if (mode == 5) return min(b, s);
  if (mode == 6) return max(b, s);
  if (mode == 7) return abs(b - s);
  if (mode == 8) {
    vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
  }
  return s;
}

float maskAlpha(vec2 p) {
  if (uMaskType == 0) return 1.0;
  float f = max(uFeather, 0.0005);
  float a = 1.0;
  if (uMaskType == 1) {
    vec2 q = abs(p - uMaskA.xy) - uMaskA.zw * 0.5;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    a = 1.0 - smoothstep(-f, f, d);
  } else if (uMaskType == 2) {
    vec2 r = max(uMaskA.zw * 0.5, vec2(0.0001));
    float d = (length((p - uMaskA.xy) / r) - 1.0) * min(r.x, r.y);
    a = 1.0 - smoothstep(-f, f, d);
  } else if (uMaskType == 3) {
    float dmin = 100000.0;
    bool inside = false;
    for (int i = 0; i < 8; i++) {
      if (i >= uPolyN) break;
      vec2 pa = uPolyA[i];
      vec2 pb = uPolyB[i];
      vec2 e = pb - pa;
      float h = clamp(dot(p - pa, e) / max(dot(e, e), 0.000001), 0.0, 1.0);
      dmin = min(dmin, length(p - pa - e * h));
      if ((pa.y > p.y) != (pb.y > p.y)) {
        float x = pa.x + (p.y - pa.y) * e.x / e.y;
        if (p.x < x) inside = !inside;
      }
    }
    float d = inside ? -dmin : dmin;
    a = 1.0 - smoothstep(-f, f, d);
  } else if (uMaskType == 4) {
    vec2 dir = vec2(cos(uMaskB.x), sin(uMaskB.x));
    float t = dot(p - 0.5, dir) + 0.5;
    a = smoothstep(uMaskB.y - f, uMaskB.y + f, t);
  } else {
    float r = max(uMaskA.z, 0.0001);
    float rin = r * (1.0 - clamp(uFeather * 4.0, 0.0, 1.0));
    a = 1.0 - smoothstep(rin, r, length(p - uMaskA.xy));
  }
  return mix(a, 1.0 - a, uInvert);
}

void main() {
  vec4 back = texture2D(uBack, v_uv);
  vec2 q = (v_uv - uCenter) * vec2(uCanvasAspect, 1.0);
  float cs = cos(uAngle);
  float sn = sin(uAngle);
  q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  vec2 lu = q / uBox + 0.5;
  float inside = step(0.0, lu.x) * step(lu.x, 1.0) * step(0.0, lu.y) * step(lu.y, 1.0);
  vec4 src = uSolid > 0.5 ? vec4(uColor, 1.0) : texture2D(uTex, clamp(lu, 0.0, 1.0));
  vec3 c = adjustColor(src.rgb, uAdjA, uAdjB);
  float a = src.a * uOpacity * inside * maskAlpha(lu);
  vec3 res = blendRGB(uBlend, back.rgb, c);
  gl_FragColor = vec4(mix(back.rgb, res, a), 1.0);
}
`

const FINAL_FRAG = `${COMMON}
uniform sampler2D uImg;
uniform vec2 uRes;
uniform float uTime;
uniform vec4 uAdjA;
uniform vec4 uAdjB;
uniform vec4 uFxA;
uniform float uGlitch;

void main() {
  vec2 uv = v_uv;
  float split = 0.0;
  if (uGlitch > 0.0) {
    float t = floor(uTime * 12.0);
    float band = floor(uv.y * 14.0 + hash(vec2(t, 1.0)) * 14.0);
    if (hash(vec2(band, t)) > 1.0 - uGlitch * 0.5) {
      uv.x += (hash(vec2(band, t + 7.0)) - 0.5) * 0.12 * uGlitch;
      split = 0.012 * uGlitch;
    }
  }
  vec3 c = texture2D(uImg, uv).rgb;
  if (split > 0.0) {
    c.r = texture2D(uImg, uv + vec2(split, 0.0)).r;
    c.b = texture2D(uImg, uv - vec2(split, 0.0)).b;
  }
  if (uFxA.y > 0.0) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float ang = float(i) * 0.5236;
      vec2 o = vec2(cos(ang), sin(ang));
      acc += max(texture2D(uImg, uv + o * 0.012).rgb - 0.55, 0.0);
      acc += max(texture2D(uImg, uv + o * 0.030).rgb - 0.55, 0.0);
    }
    c += acc / 24.0 * uFxA.y * 3.0;
  }
  c = adjustColor(c, uAdjA, uAdjB);
  if (uFxA.z > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, vec3(l) * vec3(1.05, 0.97, 0.88) + (c - l) * 0.6, uFxA.z);
    c = c * (1.0 - 0.08 * uFxA.z) + 0.04 * uFxA.z;
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.4 * uFxA.z);
    c *= 1.0 + (hash(vec2(floor(uTime * 24.0), 3.0)) - 0.5) * 0.06 * uFxA.z;
  }
  float n = hash(uv * uRes + fract(uTime) * 100.0) - 0.5;
  c += n * (uFxA.x * 0.35 + uFxA.z * 0.12);
  float v = smoothstep(0.35, 0.95, length((uv - 0.5) * vec2(1.0, 0.8)) * 1.35);
  c *= 1.0 - uFxA.w * 0.85 * v;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

type Uniforms = Record<string, WebGLUniformLocation | null>

interface Program {
  program: WebGLProgram
  u: Uniforms
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

/** Mask → shader uniforms (the UI's y runs downward, the shader's upward: flipped here). */
export function maskUniforms(mask: LayerMask | null, ctrlPoints = 8) {
  const out = {
    type: 0,
    a: [0, 0, 0, 0] as [number, number, number, number],
    b: [0, 0, 0, 0] as [number, number, number, number],
    feather: 0,
    invert: 0,
    polyA: new Float32Array(ctrlPoints * 2),
    polyB: new Float32Array(ctrlPoints * 2),
    polyN: 0,
  }
  if (!mask) return out
  out.feather = (mask.feather / 100) * 0.3
  out.invert = mask.invert ? 1 : 0
  switch (mask.type) {
    case 'rect':
      out.type = 1
      out.a = [mask.x, 1 - mask.y, mask.w, mask.h]
      break
    case 'ellipse':
      out.type = 2
      out.a = [mask.x, 1 - mask.y, mask.w, mask.h]
      break
    case 'polygon': {
      out.type = 3
      const pts = mask.points.slice(0, ctrlPoints)
      out.polyN = pts.length
      pts.forEach((p, i) => {
        const n = pts[(i + 1) % pts.length]
        out.polyA.set([p[0], 1 - p[1]], i * 2)
        out.polyB.set([n[0], 1 - n[1]], i * 2)
      })
      break
    }
    case 'linear':
      out.type = 4
      out.b = [(-mask.angle * Math.PI) / 180, mask.position, 0, 0]
      break
    case 'radial':
      out.type = 5
      out.a = [mask.x, 1 - mask.y, mask.radius, 0]
      break
  }
  return out
}

const norm = (a: Adjustments): [[number, number, number, number], [number, number, number, number]] => [
  [a.exposure / 100, a.brightness / 100, a.contrast / 100, a.saturation / 100],
  [a.temperature / 100, a.tint / 100, a.highlights / 100, a.shadows / 100],
]

export class Compositor {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private layerProg: Program
  private finalProg: Program
  private targets: Target[] = []
  private textures = new Map<string, { tex: WebGLTexture; w: number; h: number; failed: boolean }>()
  private buffer: WebGLBuffer
  private width = 0
  private height = 0
  lost = false

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
    if (!gl) throw new Error('這個瀏覽器不支援 WebGL')
    this.canvas = canvas
    this.gl = gl
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    this.layerProg = this.link(LAYER_FRAG, ['uBack', 'uTex', 'uCanvasAspect', 'uCenter', 'uBox', 'uAngle', 'uOpacity', 'uBlend', 'uSolid', 'uColor', 'uAdjA', 'uAdjB', 'uMaskType', 'uMaskA', 'uMaskB', 'uFeather', 'uInvert', 'uPolyA', 'uPolyB', 'uPolyN'])
    this.finalProg = this.link(FINAL_FRAG, ['uImg', 'uRes', 'uTime', 'uAdjA', 'uAdjB', 'uFxA', 'uGlitch'])
    this.buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.disable(gl.BLEND)
  }

  private compile(type: number, source: string) {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`)
    return shader
  }

  private link(frag: string, names: string[]): Program {
    const gl = this.gl
    const program = gl.createProgram()!
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`)
    const u: Uniforms = {}
    for (const n of names) u[n] = gl.getUniformLocation(program, n)
    return { program, u }
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { tex, fbo }
  }

  /** Size of the drawing buffer in pixels (the CSS size × device pixel ratio, capped by the caller). */
  setSize(w: number, h: number) {
    w = Math.max(2, Math.round(w))
    h = Math.max(2, Math.round(h))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.canvas.width = w
    this.canvas.height = h
    const gl = this.gl
    for (const t of this.targets) {
      gl.deleteTexture(t.tex)
      gl.deleteFramebuffer(t.fbo)
    }
    this.targets = [this.makeTarget(w, h), this.makeTarget(w, h)]
  }

  private texture(layer: RenderLayer) {
    const gl = this.gl
    let entry = this.textures.get(layer.key)
    const fresh = !entry
    if (!entry) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { tex, w: layer.width, h: layer.height, failed: false }
      this.textures.set(layer.key, entry)
    }
    if (layer.source && (fresh || layer.dynamic) && !entry.failed) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source)
      } catch {
        // A tainted (cross-origin without CORS) source can't be read by WebGL: that layer stays blank.
        entry.failed = true
      }
    }
    return entry
  }

  /** Free textures no layer uses any more. */
  prune(keep: Set<string>) {
    for (const [key, t] of this.textures) {
      if (!keep.has(key)) {
        this.gl.deleteTexture(t.tex)
        this.textures.delete(key)
      }
    }
  }

  /** Did a source fail to upload (blocked by CORS)? */
  failed(key: string) {
    return this.textures.get(key)?.failed ?? false
  }

  private quad(prog: Program) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const loc = gl.getAttribLocation(prog.program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  render(spec: RenderSpec) {
    if (this.lost || this.targets.length < 2) return
    const gl = this.gl
    const aspect = this.width / this.height
    gl.viewport(0, 0, this.width, this.height)
    let ping = 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].fbo)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const { program: lp, u } = this.layerProg
    gl.useProgram(lp)
    const keep = new Set<string>()
    for (const layer of spec.layers) {
      keep.add(layer.key)
      if (layer.opacity <= 0) continue
      let ar = layer.width / Math.max(1, layer.height)
      if (!layer.solid) {
        if (!layer.source || !layer.width || !layer.height) continue
        const entry = this.texture(layer)
        if (entry.failed) continue
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      } else {
        ar = aspect
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1 - ping].fbo)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.targets[ping].tex)
      gl.uniform1i(u.uBack, 0)
      gl.uniform1i(u.uTex, 1)
      gl.uniform1f(u.uCanvasAspect, aspect)
      gl.uniform2f(u.uCenter, layer.x, 1 - layer.y)
      // The layer fits the stage ("contain") at scale 1; sizes are in units of the stage height.
      const bw = (ar > aspect ? aspect : ar) * layer.scale
      const bh = (ar > aspect ? aspect / ar : 1) * layer.scale
      gl.uniform2f(u.uBox, bw, bh)
      gl.uniform1f(u.uAngle, (-layer.rotation * Math.PI) / 180)
      gl.uniform1f(u.uOpacity, layer.opacity)
      gl.uniform1i(u.uBlend, blendCode(layer.blend))
      gl.uniform1f(u.uSolid, layer.solid ? 1 : 0)
      gl.uniform3f(u.uColor, layer.color[0], layer.color[1], layer.color[2])
      const [a, b] = norm(layer.adjust)
      gl.uniform4fv(u.uAdjA, a)
      gl.uniform4fv(u.uAdjB, b)
      const m = maskUniforms(layer.mask)
      gl.uniform1i(u.uMaskType, m.type)
      gl.uniform4fv(u.uMaskA, m.a)
      gl.uniform4fv(u.uMaskB, m.b)
      gl.uniform1f(u.uFeather, m.feather)
      gl.uniform1f(u.uInvert, m.invert)
      gl.uniform2fv(u.uPolyA, m.polyA)
      gl.uniform2fv(u.uPolyB, m.polyB)
      gl.uniform1i(u.uPolyN, m.polyN)
      this.quad(this.layerProg)
      ping = 1 - ping
    }
    this.prune(keep)

    // Whole-picture grading and effects, to the screen.
    const { program: fp, u: fu } = this.finalProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(fp)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.targets[ping].tex)
    gl.uniform1i(fu.uImg, 0)
    gl.uniform2f(fu.uRes, this.width, this.height)
    gl.uniform1f(fu.uTime, spec.time)
    const [ga, gb] = norm(spec.adjust)
    gl.uniform4fv(fu.uAdjA, ga)
    gl.uniform4fv(fu.uAdjB, gb)
    gl.uniform4f(fu.uFxA, spec.fx.grain / 100, spec.fx.glow / 100, spec.fx.film / 100, spec.fx.vignette / 100)
    gl.uniform1f(fu.uGlitch, spec.fx.glitch / 100)
    this.quad(this.finalProg)
  }

  dispose() {
    const gl = this.gl
    for (const t of this.textures.values()) gl.deleteTexture(t.tex)
    for (const t of this.targets) {
      gl.deleteTexture(t.tex)
      gl.deleteFramebuffer(t.fbo)
    }
    this.textures.clear()
    this.targets = []
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
