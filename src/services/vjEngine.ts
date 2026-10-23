import { fxDef, fxUniform, vjBlendCode, type VjBlend, type VjFx } from '../types/vj'

/*
 * WebGL 2 renderer for the live VJ mix.
 *
 *   per layer:  clip → (contain-fit, premultiplied) → effect passes (ping-pong) ─┐
 *   mix:        previous mix + layer, blended (Normal / Add / Multiply / Screen / Overlay / Difference) ◄┘
 *   master:     master effect passes → canvas
 *
 * Everything is a full-screen pass on the GPU; the CPU only uploads video frames. Effects share one
 * fragment shader selected by a uniform, so a chain is just repeated draws between two targets.
 */

export interface VjRenderLayer {
  /** Texture cache key (layer index + source). */
  key: string
  source: TexImageSource | null
  width: number
  height: number
  /** Re-upload every frame (a playing video). */
  dynamic: boolean
  /** Effective opacity (fader × crossfader). */
  opacity: number
  blend: VjBlend
  fx: VjFx[]
}

export interface VjRenderSpec {
  layers: VjRenderLayer[]
  masterFx: VjFx[]
  /** 0 … 1 overall level. */
  master: number
  /** Seconds, drives the animated effects. */
  time: number
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`

/** Clip → layer target: contain-fit, straight alpha uploaded, written premultiplied. */
const FIT_FRAG = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uBox;
void main() {
  vec2 lu = (v_uv - 0.5) / uBox + 0.5;
  float inside = step(0.0, lu.x) * step(lu.x, 1.0) * step(0.0, lu.y) * step(lu.y, 1.0);
  vec4 c = texture(uTex, clamp(lu, 0.0, 1.0));
  c.a *= inside;
  outColor = vec4(c.rgb * c.a, c.a);
}
`

const BLEND_FN = `
vec3 blendRGB(int mode, vec3 b, vec3 s) {
  if (mode == 1) return min(b + s, 1.0);
  if (mode == 2) return b * s;
  if (mode == 3) return 1.0 - (1.0 - b) * (1.0 - s);
  if (mode == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 5) return abs(b - s);
  return s;
}
`

/** Previous mix (opaque) + a premultiplied layer. */
const COMPOSE_FRAG = `${HEAD}
uniform sampler2D uBack;
uniform sampler2D uLayer;
uniform float uOpacity;
uniform int uBlend;
${BLEND_FN}
void main() {
  vec3 back = texture(uBack, v_uv).rgb;
  vec4 l = texture(uLayer, v_uv);
  float a = l.a * uOpacity;
  vec3 src = l.a > 0.0001 ? l.rgb / l.a : vec3(0.0);
  vec3 res = blendRGB(uBlend, back, src);
  outColor = vec4(mix(back, res, a), 1.0);
}
`

const FX_FRAG = `${HEAD}
uniform sampler2D uImg;
uniform vec2 uRes;
uniform float uTime;
uniform int uType;
uniform vec4 uP;

vec4 unpremul(vec4 c) { return c.a > 0.0001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec3 hueRotate(vec3 c, float a) {
  // Rotation about the grey axis (1,1,1)/sqrt(3).
  const vec3 k = vec3(0.57735026);
  float cs = cos(a);
  return clamp(c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs), 0.0, 1.0);
}
vec4 blurAt(vec2 uv, float px) {
  vec2 r = px / uRes;
  vec4 acc = texture(uImg, uv) * 0.16;
  float wsum = 0.16;
  for (int ring = 1; ring <= 3; ring++) {
    float rr = float(ring) / 3.0;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.7854 + float(ring) * 0.39;
      float w = 1.0 - rr * 0.55;
      acc += texture(uImg, uv + vec2(cos(ang), sin(ang)) * r * rr) * w;
      wsum += w;
    }
  }
  return acc / wsum;
}

void main() {
  vec2 uv = v_uv;
  vec4 c;
  if (uType == 1) {
    // Glitch: horizontal bands tear sideways, channels split, noise bursts.
    float amt = uP.x / 100.0;
    float t = floor(uTime * uP.y);
    float band = floor(uv.y * 16.0 + hash(vec2(t, 1.0)) * 16.0);
    float hit = step(1.0 - amt * 0.6, hash(vec2(band, t)));
    uv.x += (hash(vec2(band, t + 7.0)) - 0.5) * 0.16 * amt * hit;
    float split = 0.015 * amt * hit;
    vec4 base = texture(uImg, uv);
    c = vec4(texture(uImg, uv + vec2(split, 0.0)).r, base.g, texture(uImg, uv - vec2(split, 0.0)).b, base.a);
    float n = hash(uv * uRes + t) - 0.5;
    c.rgb += n * amt * 0.5 * hit * c.a;
  } else if (uType == 2) {
    // Strobe: the picture flashes to black (or white) at the given rate.
    c = texture(uImg, uv);
    float on = step(0.5, fract(uTime * uP.x));
    float k = 1.0 - on * (uP.y / 100.0);
    c.rgb = uP.z > 0.5 ? mix(c.rgb, vec3(1.0) * c.a, on * (uP.y / 100.0)) : c.rgb * k;
  } else if (uType == 3) {
    // Hue rotate / saturation.
    c = unpremul(texture(uImg, uv));
    float ang = radians(uP.x + uP.y * uTime);
    c.rgb = hueRotate(c.rgb, ang);
    float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    c.rgb = clamp(mix(vec3(l), c.rgb, uP.z / 100.0), 0.0, 1.0);
    c = premul(c);
  } else if (uType == 4) {
    c = blurAt(uv, uP.x);
  } else if (uType == 5) {
    // Glow: bright parts bleed outwards.
    c = texture(uImg, uv);
    vec4 b = blurAt(uv, uP.y);
    float thr = uP.z / 100.0;
    vec3 bright = max(b.rgb - thr * b.a, 0.0);
    c.rgb = min(c.rgb + bright * (uP.x / 100.0) * 2.0, 1.0);
    c.a = max(c.a, b.a * min(uP.x / 100.0, 1.0));
  } else if (uType == 6) {
    if (uP.x > 0.5 && uv.x > 0.5) uv.x = 1.0 - uv.x;
    if (uP.y > 0.5 && uv.y > 0.5) uv.y = 1.0 - uv.y;
    c = texture(uImg, uv);
  } else if (uType == 7) {
    // Kaleidoscope: fold the angle into N mirrored wedges.
    vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r = length(p);
    float a = atan(p.y, p.x) + radians(uP.y + uP.z * uTime);
    float seg = 6.28318530718 / max(uP.x, 2.0);
    a = abs(mod(a, seg) - seg * 0.5);
    vec2 q = vec2(cos(a), sin(a)) * r;
    uv = q / vec2(uRes.x / uRes.y, 1.0) + 0.5;
    c = texture(uImg, clamp(uv, 0.0, 1.0));
  } else {
    c = texture(uImg, uv);
  }
  outColor = c;
}
`

/** Last pass: master level, to the canvas. */
const OUT_FRAG = `${HEAD}
uniform sampler2D uImg;
uniform float uLevel;
void main() { outColor = vec4(texture(uImg, v_uv).rgb * uLevel, 1.0); }
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

export class VjEngine {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private fitProg: Program
  private composeProg: Program
  private fxProg: Program
  private outProg: Program
  private vao: WebGLVertexArrayObject
  /** 0,1: the mix (ping-pong); 2,3: the layer being built (ping-pong). */
  private targets: Target[] = []
  private textures = new Map<string, { tex: WebGLTexture; failed: boolean }>()
  private width = 0
  private height = 0
  lost = false

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
    if (!gl) throw new Error('這個瀏覽器不支援 WebGL 2.0')
    this.canvas = canvas
    this.gl = gl
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    this.fitProg = this.link(FIT_FRAG, ['uTex', 'uBox'])
    this.composeProg = this.link(COMPOSE_FRAG, ['uBack', 'uLayer', 'uOpacity', 'uBlend'])
    this.fxProg = this.link(FX_FRAG, ['uImg', 'uRes', 'uTime', 'uType', 'uP'])
    this.outProg = this.link(OUT_FRAG, ['uImg', 'uLevel'])
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    // a_pos is bound to location 0 in every program, so one attribute setup serves them all.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
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
    gl.bindAttribLocation(program, 0, 'a_pos')
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { tex, fbo }
  }

  /** Size of the drawing buffer in pixels. */
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
    this.targets = [0, 1, 2, 3].map(() => this.makeTarget(w, h))
  }

  private texture(layer: VjRenderLayer) {
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
      entry = { tex, failed: false }
      this.textures.set(layer.key, entry)
    }
    if (layer.source && (fresh || layer.dynamic) && !entry.failed) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source)
      } catch {
        // A cross-origin source without CORS can't be read by WebGL: that layer stays blank.
        entry.failed = true
      }
    }
    return entry
  }

  private prune(keep: Set<string>) {
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

  private draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4)
  }

  private bindTarget(i: number) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.targets[i].fbo)
  }

  private bindTex(unit: number, tex: WebGLTexture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit)
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex)
  }

  /**
   * Run a chain between two targets, starting from the one in `from` ([a, b] indices); returns the index
   * that holds the result. A chain without enabled effects returns `from` untouched.
   */
  private runFx(chain: VjFx[], from: number, other: number, time: number): number {
    const gl = this.gl
    const active = chain.filter((f) => f.enabled)
    if (!active.length) return from
    const { program, u } = this.fxProg
    gl.useProgram(program)
    gl.uniform1i(u.uImg, 0)
    gl.uniform2f(u.uRes, this.width, this.height)
    gl.uniform1f(u.uTime, time)
    let src = from
    let dst = other
    for (const fx of active) {
      this.bindTarget(dst)
      this.bindTex(0, this.targets[src].tex)
      gl.uniform1i(u.uType, fxDef(fx.type).code)
      gl.uniform4fv(u.uP, fxUniform(fx))
      this.draw()
      ;[src, dst] = [dst, src]
    }
    return src
  }

  render(spec: VjRenderSpec) {
    if (this.lost || this.targets.length < 4) return
    const gl = this.gl
    const aspect = this.width / this.height
    gl.viewport(0, 0, this.width, this.height)
    gl.bindVertexArray(this.vao)

    let mix = 0
    this.bindTarget(mix)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const keep = new Set<string>()
    for (const layer of spec.layers) {
      keep.add(layer.key)
      if (layer.opacity <= 0.0005 || !layer.source || !layer.width || !layer.height) continue
      const entry = this.texture(layer)
      if (entry.failed) continue

      // 1. clip → target 2 (contain-fit, premultiplied)
      const ar = layer.width / layer.height
      this.bindTarget(2)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(this.fitProg.program)
      this.bindTex(0, entry.tex)
      gl.uniform1i(this.fitProg.u.uTex, 0)
      gl.uniform2f(this.fitProg.u.uBox, ar > aspect ? 1 : ar / aspect, ar > aspect ? aspect / ar : 1)
      this.draw()

      // 2. the layer's effect chain
      const layerTex = this.runFx(layer.fx, 2, 3, spec.time)

      // 3. blend onto the mix
      const out = 1 - mix
      this.bindTarget(out)
      gl.useProgram(this.composeProg.program)
      this.bindTex(0, this.targets[mix].tex)
      this.bindTex(1, this.targets[layerTex].tex)
      gl.uniform1i(this.composeProg.u.uBack, 0)
      gl.uniform1i(this.composeProg.u.uLayer, 1)
      gl.uniform1f(this.composeProg.u.uOpacity, layer.opacity)
      gl.uniform1i(this.composeProg.u.uBlend, vjBlendCode(layer.blend))
      this.draw()
      mix = out
    }
    this.prune(keep)

    // 4. master effects (ping-pong between the two mix targets), then to the canvas with the master level
    const result = this.runFx(spec.masterFx, mix, 1 - mix, spec.time)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.outProg.program)
    this.bindTex(0, this.targets[result].tex)
    gl.uniform1i(this.outProg.u.uImg, 0)
    gl.uniform1f(this.outProg.u.uLevel, Math.min(1, Math.max(0, spec.master)))
    this.draw()
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
