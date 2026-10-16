/** Walmart PIE (embed=false) PAN and CVV encryption. The key is fetched at checkout; card data never leaves this process until the ciphertext is posted to www.walmart.com. */

export interface PieKey {
  L: number
  E: number
  K: string
  keyId: string
  phase: number
}

export interface PieCipher {
  encryptedPan: string
  encryptedCvv: string
  integrityCheck: string
  keyId: string
  phase: number
}

const BASE10 = "0123456789"
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export function parsePieKey(source: string): PieKey | null {
  const L = source.match(/PIE\.L\s*=\s*(\d+)/)
  const E = source.match(/PIE\.E\s*=\s*(\d+)/)
  const K = source.match(/PIE\.K\s*=\s*["']([0-9A-Fa-f]+)["']/)
  const keyId = source.match(/PIE\.key_id\s*=\s*["']([0-9A-Fa-f]+)["']/)
  const phase = source.match(/PIE\.phase\s*=\s*(\d+)/)
  if (!L?.[1] || !E?.[1] || !K?.[1] || !keyId?.[1] || !phase?.[1]) return null
  if (K[1].length !== 32) return null
  return { L: Number(L[1]), E: Number(E[1]), K: K[1], keyId: keyId[1], phase: Number(phase[1]) }
}

export function protectPanAndCvv(pan: string, cvv: string, key: PieKey): PieCipher | null {
  const digits = distill(pan)
  const secret = distill(cvv)
  if (digits.length < 13 || digits.length > 19 || secret.length > 4 || secret.length === 1 || secret.length === 2) return null
  if (luhn(digits) !== 0) return null
  const prefix = digits.slice(0, key.L)
  const suffix = digits.slice(digits.length - key.E)
  const tweak = prefix + suffix
  const middle = digits.slice(key.L + 1, digits.length - key.E)
  const width = 23 - key.L - key.E
  const payload = middle + secret
  const pad = Math.floor((width * Math.log(62) - 34 * Math.log(2)) / Math.log(10)) - payload.length - 1
  if (pad < 0) return null
  const head = `${"1".repeat(pad)}${2 * secret.length}`
  const cipher = aesFromKey(key.K)
  if (!cipher) return null
  const encrypted = `1${ffxEncrypt(head + payload, tweak, cipher, 10)}`
  const digits10 = [...encrypted].map((char) => Number.parseInt(char, 10))
  const converted = convertRadix(digits10, encrypted.length, 10, width, 62)
  bnMultiply(converted, 62, 131072)
  bnMultiply(converted, 62, 65536)
  bnAdd(converted, 62, Number.parseInt(key.keyId, 16))
  if (key.phase === 1) bnAdd(converted, 62, 4294967296)
  let body = ""
  for (let i = 0; i < width; i += 1) body += BASE62.charAt(converted[i] ?? 0)
  const encryptedPan = prefix + body.slice(0, width - 4) + suffix
  const encryptedCvv = body.slice(width - 4)
  return {
    encryptedPan,
    encryptedCvv,
    integrityCheck: integrity(key.K, encryptedPan, encryptedCvv),
    keyId: key.keyId,
    phase: key.phase
  }
}

function distill(value: string): string {
  let out = ""
  for (const char of value) if (BASE10.includes(char)) out += char
  return out
}

function luhn(value: string): number {
  let sum = 0
  for (let i = value.length - 1; i >= 0; i -= 2) sum += Number.parseInt(value.charAt(i), 10)
  for (let i = value.length - 2; i >= 0; i -= 2) {
    const doubled = 2 * Number.parseInt(value.charAt(i), 10)
    sum += doubled < 10 ? doubled : doubled - 9
  }
  return sum % 10
}

function integrity(keyHex: string, pan: string, cvv: string): string {
  const material = `${String.fromCharCode(0)}${String.fromCharCode(pan.length)}${pan}${String.fromCharCode(0)}${String.fromCharCode(cvv.length)}${cvv}`
  const words = hexToWords(keyHex)
  if (!words) return ""
  words[3] ^= 1
  const mac = cmac(new Aes(words), material)
  return wordToHex(mac[0] ?? 0) + wordToHex(mac[1] ?? 0)
}

const HEX = "0123456789abcdef"

function hexToWords(hex: string): number[] | null {
  if (hex.length !== 32) return null
  const words = [0, 0, 0, 0]
  for (let i = 0; i < 4; i += 1) words[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16)
  return words
}

function wordToHex(word: number): string {
  let out = ""
  let shift = 32
  while (shift > 0) {
    shift -= 4
    out += HEX.charAt((word >>> shift) & 15)
  }
  return out
}

function aesFromKey(hex: string): Aes | null {
  const words = hexToWords(hex)
  return words ? new Aes(words) : null
}

const sbox: number[][] = [[], [], [], [], []]
let tablesReady = false

function precomputeTables(): void {
  if (tablesReady) return
  const enc: number[][] = [[], [], [], [], []]
  const dec: number[][] = [[], [], [], [], []]
  const sboxRow = enc[4] ?? []
  const invRow = dec[4] ?? []
  enc[4] = sboxRow
  dec[4] = invRow
  const xtime: number[] = []
  const invert: number[] = []
  for (let i = 0; i < 256; i += 1) invert[(xtime[i] = (i << 1) ^ ((i >> 7) * 283)) ^ i] = i
  let x = 0
  let y = 0
  let chain = 0
  for (; !sboxRow[x]; x ^= chain === 0 ? 1 : chain, y = invert[y] === 0 ? 1 : (invert[y] as number)) {
    let box = y ^ (y << 1) ^ (y << 2) ^ (y << 3) ^ (y << 4)
    box = (box >> 8) ^ (box & 255) ^ 99
    sboxRow[x] = box
    invRow[box] = x
    const once = xtime[x] ?? 0
    const twice = xtime[once] ?? 0
    const thrice = xtime[twice] ?? 0
    chain = once
    let encMix = ((xtime[box] ?? 0) * 257) ^ (box * 16843008)
    let decMix = thrice * 16843009 ^ twice * 65537 ^ once * 257 ^ x * 16843008
    for (let row = 0; row < 4; row += 1) {
      const encTable = enc[row] ?? []
      const decTable = dec[row] ?? []
      enc[row] = encTable
      dec[row] = decTable
      encTable[x] = encMix = (encMix << 24) ^ (encMix >>> 8)
      decTable[box] = decMix = (decMix << 24) ^ (decMix >>> 8)
    }
  }
  for (let row = 0; row < 5; row += 1) sbox[row] = enc[row] ?? []
  tablesReady = true
}

class Aes {
  private readonly key: number[]

  constructor(words: number[]) {
    precomputeTables()
    const length = words.length
    const expanded = words.slice()
    const box = sbox[4] ?? []
    let round = 1
    for (let i = length; i < 4 * length + 28; i += 1) {
      let word = expanded[i - 1] ?? 0
      if (i % length === 0 || (length === 8 && i % length === 4)) {
        word = ((box[word >>> 24] ?? 0) << 24) ^ ((box[(word >> 16) & 255] ?? 0) << 16) ^ ((box[(word >> 8) & 255] ?? 0) << 8) ^ (box[word & 255] ?? 0)
        if (i % length === 0) {
          word = (word << 8) ^ (word >>> 24) ^ (round << 24)
          round = (round << 1) ^ ((round >> 7) * 283)
        }
      }
      expanded[i] = (expanded[i - length] ?? 0) ^ word
    }
    this.key = expanded
  }

  encrypt(block: number[]): number[] {
    const key = this.key
    let a = (block[0] ?? 0) ^ (key[0] ?? 0)
    let b = (block[1] ?? 0) ^ (key[1] ?? 0)
    let c = (block[2] ?? 0) ^ (key[2] ?? 0)
    let d = (block[3] ?? 0) ^ (key[3] ?? 0)
    const rounds = key.length / 4 - 2
    let offset = 4
    const t0 = sbox[0] ?? []
    const t1 = sbox[1] ?? []
    const t2 = sbox[2] ?? []
    const t3 = sbox[3] ?? []
    const box = sbox[4] ?? []
    for (let round = 0; round < rounds; round += 1) {
      const na = (t0[a >>> 24] ?? 0) ^ (t1[(b >> 16) & 255] ?? 0) ^ (t2[(c >> 8) & 255] ?? 0) ^ (t3[d & 255] ?? 0) ^ (key[offset] ?? 0)
      const nb = (t0[b >>> 24] ?? 0) ^ (t1[(c >> 16) & 255] ?? 0) ^ (t2[(d >> 8) & 255] ?? 0) ^ (t3[a & 255] ?? 0) ^ (key[offset + 1] ?? 0)
      const nc = (t0[c >>> 24] ?? 0) ^ (t1[(d >> 16) & 255] ?? 0) ^ (t2[(a >> 8) & 255] ?? 0) ^ (t3[b & 255] ?? 0) ^ (key[offset + 2] ?? 0)
      d = (t0[d >>> 24] ?? 0) ^ (t1[(a >> 16) & 255] ?? 0) ^ (t2[(b >> 8) & 255] ?? 0) ^ (t3[c & 255] ?? 0) ^ (key[offset + 3] ?? 0)
      offset += 4
      a = na
      b = nb
      c = nc
    }
    const out = [0, 0, 0, 0]
    for (let i = 0; i < 4; i += 1) {
      out[i] = ((box[a >>> 24] ?? 0) << 24) ^ ((box[(b >> 16) & 255] ?? 0) << 16) ^ ((box[(c >> 8) & 255] ?? 0) << 8) ^ (box[d & 255] ?? 0) ^ (key[offset++] ?? 0)
      const rotate = a
      a = b
      b = c
      c = d
      d = rotate
    }
    return out
  }
}

function cmac(aes: Aes, data: string): number[] {
  const zero = aes.encrypt([0, 0, 0, 0])
  const sub = zero.slice()
  const msb = sub[0] ?? 0
  leftShift(sub)
  if (msbNotZero(msb)) sub[3] = (sub[3] ?? 0) ^ 135
  const block = [0, 0, 0, 0]
  let index = 0
  while (index < data.length) {
    block[(index >> 2) & 3] = (block[(index >> 2) & 3] ?? 0) ^ ((data.charCodeAt(index) & 255) << (8 * (3 - (index & 3))))
    index += 1
    if ((index & 15) === 0 && index < data.length) {
      const next = aes.encrypt(block)
      block[0] = next[0] ?? 0
      block[1] = next[1] ?? 0
      block[2] = next[2] ?? 0
      block[3] = next[3] ?? 0
    }
  }
  if (index === 0 || (index & 15) !== 0) {
    const mark = sub[0] ?? 0
    leftShift(sub)
    if (msbNotZero(mark)) sub[3] = (sub[3] ?? 0) ^ 135
    block[(index >> 2) & 3] = (block[(index >> 2) & 3] ?? 0) ^ (128 << (8 * (3 - (index & 3))))
  }
  block[0] = (block[0] ?? 0) ^ (sub[0] ?? 0)
  block[1] = (block[1] ?? 0) ^ (sub[1] ?? 0)
  block[2] = (block[2] ?? 0) ^ (sub[2] ?? 0)
  block[3] = (block[3] ?? 0) ^ (sub[3] ?? 0)
  return aes.encrypt(block)
}

function msbNotZero(word: number): boolean {
  return (word | 2147483647) !== 2147483647
}

function leftShift(words: number[]): void {
  words[0] = (((words[0] ?? 0) & 2147483647) << 1) | ((words[1] ?? 0) >>> 31)
  words[1] = (((words[1] ?? 0) & 2147483647) << 1) | ((words[2] ?? 0) >>> 31)
  words[2] = (((words[2] ?? 0) & 2147483647) << 1) | ((words[3] ?? 0) >>> 31)
  words[3] = ((words[3] ?? 0) & 2147483647) << 1
}

const ALPHABET = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"]

function ffxEncrypt(value: string, tweak: string, aes: Aes, radix: number): string {
  return ffxEncryptWithCipher(value, tweak, aes, radix)
}

function ffxEncryptWithCipher(value: string, tweak: string, aes: Aes, radix: number): string {
  const length = value.length
  const half = Math.floor(length / 2)
  const seed = precompF(aes, length, tweak, radix)
  const bytes = precompB(radix, length)
  let left = digitToVal(value, half, radix)
  let right = digitToVal(value.slice(half), length - half, radix)
  if (!left || !right) return ""
  for (let round = 0; round < 5; round += 1) {
    const addLeft = ffxRound(aes, round * 2, tweak, right, right.length, left.length, seed, radix, bytes)
    left = addDigits(left, addLeft, radix)
    const addRight = ffxRound(aes, round * 2 + 1, tweak, left, left.length, right.length, seed, radix, bytes)
    right = addDigits(right, addRight, radix)
  }
  return valToDigit(left, radix) + valToDigit(right, radix)
}

function precompF(aes: Aes, length: number, tweak: string, radix: number): number[] {
  const block = [
    16908544 | ((radix >> 16) & 255),
    (((radix >> 8) & 255) << 24) | ((radix & 255) << 16) | (10 << 8) | (Math.floor(length / 2) & 255),
    length,
    tweak.length
  ]
  return aes.encrypt(block)
}

function precompB(radix: number, length: number): number {
  let half = Math.ceil(length / 2)
  let bytes = 0
  let value = 1
  while (half > 0) {
    value *= radix
    half -= 1
    if (value >= 256) {
      value /= 256
      bytes += 1
    }
  }
  if (value > 1) bytes += 1
  return bytes
}

function bnMultiply(digits: number[], radix: number, factor: number): void {
  let carry = 0
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const next = (digits[i] ?? 0) * factor + carry
    digits[i] = next % radix
    carry = (next - (digits[i] ?? 0)) / radix
  }
}

function bnAdd(digits: number[], radix: number, amount: number): void {
  let index = digits.length - 1
  let carry = amount
  while (index >= 0 && carry > 0) {
    const next = (digits[index] ?? 0) + carry
    digits[index] = next % radix
    carry = (next - (digits[index] ?? 0)) / radix
    index -= 1
  }
}

function convertRadix(value: number[], length: number, from: number, outLength: number, to: number): number[] {
  const out = new Array<number>(outLength).fill(0)
  for (let i = 0; i < length; i += 1) {
    bnMultiply(out, to, from)
    bnAdd(out, to, value[i] ?? 0)
  }
  return out
}

function cbcmac(seed: number[], data: number[], length: number, aes: Aes): number[] {
  let block = seed.slice(0, 4)
  let group = 0
  while (4 * group < length) {
    for (let i = 0; i < 4; i += 1) {
      block[i] = (block[i] ?? 0) ^ (((data[4 * (group + i)] ?? 0) << 24) | ((data[4 * (group + i) + 1] ?? 0) << 16) | ((data[4 * (group + i) + 2] ?? 0) << 8) | (data[4 * (group + i) + 3] ?? 0))
    }
    block = aes.encrypt(block)
    group += 4
  }
  return block
}

function ffxRound(aes: Aes, round: number, tweak: string, input: number[], inputLength: number, outLength: number, seed: number[], radix: number, width: number): number[] {
  const chunks = Math.ceil(width / 4) + 1
  let pad = (tweak.length + width + 1) & 15
  if (pad > 0) pad = 16 - pad
  const data = new Array<number>(tweak.length + pad + width + 1).fill(0)
  for (let i = 0; i < tweak.length; i += 1) data[i] = tweak.charCodeAt(i)
  data[data.length - width - 1] = round
  const packed = convertRadix(input, inputLength, radix, width, 256)
  for (let i = 0; i < width; i += 1) data[data.length - width + i] = packed[i] ?? 0
  let mac = cbcmac(seed, data, data.length, aes)
  const words = new Array<number>(2 * chunks)
  for (let i = 0; i < chunks; i += 1) {
    if (i > 0 && (i & 3) === 0) mac = aes.encrypt([mac[0] ?? 0, mac[1] ?? 0, mac[2] ?? 0, (mac[3] ?? 0) ^ (i >> 2)])
    words[2 * i] = (mac[i & 3] ?? 0) >>> 16
    words[2 * i + 1] = (mac[i & 3] ?? 0) & 65535
  }
  return convertRadix(words, 2 * chunks, 65536, outLength, radix)
}

function digitToVal(value: string, length: number, radix: number): number[] | null {
  const out = new Array<number>(length)
  for (let i = 0; i < length; i += 1) {
    const digit = Number.parseInt(value.charAt(i), radix)
    if (Number.isNaN(digit) || digit >= radix) return null
    out[i] = digit
  }
  return out
}

function valToDigit(digits: number[], radix: number): string {
  let out = ""
  if (radix === 256) {
    for (const digit of digits) out += String.fromCharCode(digit)
    return out
  }
  for (const digit of digits) out += ALPHABET[digit] ?? ""
  return out
}

function addDigits(left: number[], right: number[], radix: number): number[] {
  const out = left.slice()
  let carry = 0
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const sum = (out[i] ?? 0) + (right[i] ?? 0) + carry
    if (sum < radix) {
      out[i] = sum
      carry = 0
    } else {
      out[i] = sum - radix
      carry = 1
    }
  }
  return out
}
