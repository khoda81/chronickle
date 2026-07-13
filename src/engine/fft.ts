/** In-place radix-2 complex FFT. `real.length` must be a power of two. */
export function fft(real: Float64Array, imaginary: Float64Array, inverse = false): void {
  const n = real.length;
  if (imaginary.length !== n || n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`fft: expected equal power-of-two lengths, got ${n}/${imaginary.length}`);
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imaginary[i]!;
      imaginary[i] = imaginary[j]!;
      imaginary[j] = ti;
    }
  }

  const direction = inverse ? 1 : -1;
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (direction * 2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    const half = length >> 1;
    for (let offset = 0; offset < n; offset += length) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < half; j++) {
        const even = offset + j;
        const odd = even + half;
        const or = real[odd]! * wr - imaginary[odd]! * wi;
        const oi = real[odd]! * wi + imaginary[odd]! * wr;
        const er = real[even]!;
        const ei = imaginary[even]!;
        real[even] = er + or;
        imaginary[even] = ei + oi;
        real[odd] = er - or;
        imaginary[odd] = ei - oi;
        const nextWr = wr * stepReal - wi * stepImaginary;
        wi = wr * stepImaginary + wi * stepReal;
        wr = nextWr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] = real[i]! / n;
      imaginary[i] = imaginary[i]! / n;
    }
  }
}

export function nextPowerOfTwo(n: number): number {
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`nextPowerOfTwo: invalid n ${n}`);
  let result = 1;
  while (result < n) result *= 2;
  return result;
}
