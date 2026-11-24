/** The parts of Omnitone (spatial audio decoder, Apache-2.0) the app uses. */
declare module 'omnitone' {
  interface OmnitoneRenderer {
    /** A 4 / 9 / 16 channel (ACN, SN3D) input. */
    input: GainNode
    /** Binaural stereo. */
    output: GainNode
    initialize(): Promise<void>
    /** Column-major 3×3: the rotation applied to the soundfield. */
    setRotationMatrix3(matrix: ArrayLike<number>): void
  }
  const Omnitone: {
    createFOARenderer(context: BaseAudioContext, config?: Record<string, unknown>): OmnitoneRenderer
    createHOARenderer(context: BaseAudioContext, config?: { ambisonicOrder?: number }): OmnitoneRenderer
  }
  export default Omnitone
}
