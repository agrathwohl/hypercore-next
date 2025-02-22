const { EventEmitter } = require('events')
const raf = require('random-access-file')
const isOptions = require('is-options')
const hypercoreCrypto = require('hypercore-crypto')
const c = require('compact-encoding')
const b4a = require('b4a')
const Xache = require('xache')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const codecs = require('codecs')

const fsctl = requireMaybe('fsctl') || { lock: noop, sparse: noop }

const Replicator = require('./lib/replicator')
const Extensions = require('./lib/extensions')
const Core = require('./lib/core')
const BlockEncryption = require('./lib/block-encryption')
const { ReadStream, WriteStream } = require('./lib/streams')

const promises = Symbol.for('hypercore.promises')
const inspect = Symbol.for('nodejs.util.inspect.custom')

module.exports = class Hypercore extends EventEmitter {
  constructor (storage, key, opts) {
    super()

    if (isOptions(storage)) {
      opts = storage
      storage = null
      key = null
    } else if (isOptions(key)) {
      opts = key
      key = null
    }

    if (key && typeof key === 'string') {
      key = b4a.from(key, 'hex')
    }

    if (!opts) opts = {}

    if (!opts.crypto && key && key.byteLength !== 32) {
      throw new Error('Hypercore key should be 32 bytes')
    }

    if (!storage) storage = opts.storage

    this[promises] = true

    this.storage = null
    this.crypto = opts.crypto || hypercoreCrypto
    this.core = null
    this.replicator = null
    this.encryption = null
    this.extensions = opts.extensions || new Extensions()
    this.cache = opts.cache === true ? new Xache({ maxSize: 65536, maxAge: 0 }) : (opts.cache || null)

    this.valueEncoding = null
    this.encodeBatch = null

    this.key = key || null
    this.keyPair = null
    this.discoveryKey = null
    this.readable = true
    this.writable = false
    this.opened = false
    this.closed = false
    this.sessions = opts._sessions || [this]
    this.sign = opts.sign || null
    this.autoClose = !!opts.autoClose

    this.closing = null
    this.opening = this._openSession(key, storage, opts)
    this.opening.catch(noop)

    this._preappend = preappend.bind(this)
    this._snapshot = opts.snapshot || null
  }

  [inspect] (depth, opts) {
    let indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }

    return this.constructor.name + '(\n' +
      indent + '  key: ' + opts.stylize((toHex(this.key)), 'string') + '\n' +
      indent + '  discoveryKey: ' + opts.stylize(toHex(this.discoveryKey), 'string') + '\n' +
      indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
      indent + '  writable: ' + opts.stylize(this.writable, 'boolean') + '\n' +
      indent + '  sessions: ' + opts.stylize(this.sessions.length, 'number') + '\n' +
      indent + '  peers: [ ' + opts.stylize(this.peers.length, 'number') + ' ]\n' +
      indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
      indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
      indent + ')'
  }

  static createProtocolStream (isInitiator, opts = {}) {
    let outerStream = isStream(isInitiator)
      ? isInitiator
      : opts.stream
    let noiseStream = null

    if (outerStream) {
      noiseStream = outerStream.noiseStream
    } else {
      noiseStream = new NoiseSecretStream(isInitiator, null, opts)
      outerStream = noiseStream.rawStream
    }
    if (!noiseStream) throw new Error('Invalid stream')

    if (!noiseStream.userData) {
      const protocol = Replicator.createProtocol(noiseStream, opts)
      if (opts.keepAlive !== false) protocol.setKeepAlive(true)
      noiseStream.userData = protocol
      noiseStream.on('error', noop) // All noise errors already propagate through outerStream
    }

    return outerStream
  }

  static defaultStorage (storage, opts = {}) {
    if (typeof storage !== 'string') return storage
    const directory = storage
    const toLock = opts.lock || 'oplog'
    return function createFile (name) {
      const locked = name === toLock || name.endsWith('/' + toLock)
      const lock = locked ? fsctl.lock : null
      const sparse = locked ? null : null // fsctl.sparse, disable sparse on windows - seems to fail for some people. TODO: investigate
      return raf(name, { directory, lock, sparse })
    }
  }

  snapshot () {
    return this.session({ snapshot: { length: this.length, byteLength: this.byteLength, fork: this.fork } })
  }

  session (opts = {}) {
    if (this.closing) {
      // This makes the closing logic alot easier. If this turns out to be a problem
      // in practive, open an issue and we'll try to make a solution for it.
      throw new Error('Cannot make sessions on a closing core')
    }

    const Clz = opts.class || Hypercore
    const s = new Clz(this.storage, this.key, {
      ...opts,
      extensions: this.extensions,
      _opening: this.opening,
      _sessions: this.sessions
    })

    s._passCapabilities(this)
    this.sessions.push(s)

    return s
  }

  _passCapabilities (o) {
    if (!this.sign) this.sign = o.sign
    this.crypto = o.crypto
    this.key = o.key
    this.discoveryKey = o.discoveryKey
    this.core = o.core
    this.replicator = o.replicator
    this.encryption = o.encryption
    this.writable = !!this.sign
    this.autoClose = o.autoClose
  }

  async _openFromExisting (from, opts) {
    await from.opening

    for (const [name, ext] of this.extensions) {
      from.extensions.register(name, null, ext)
    }

    this._passCapabilities(from)
    this.extensions = from.extensions
    this.sessions = from.sessions
    this.storage = from.storage

    this.sessions.push(this)
  }

  async _openSession (key, storage, opts) {
    const isFirst = !opts._opening

    if (!isFirst) await opts._opening
    if (opts.preload) opts = { ...opts, ...(await opts.preload()) }

    const keyPair = (key && opts.keyPair)
      ? { ...opts.keyPair, publicKey: key }
      : key
        ? { publicKey: key, secretKey: null }
        : opts.keyPair

    // This only works if the hypercore was fully loaded,
    // but we only do this to validate the keypair to help catch bugs so yolo
    if (this.key && keyPair) keyPair.publicKey = this.key

    if (opts.sign) {
      this.sign = opts.sign
    } else if (keyPair && keyPair.secretKey) {
      this.sign = Core.createSigner(this.crypto, keyPair)
    }

    if (isFirst) {
      await this._openCapabilities(keyPair, storage, opts)
      // Only the root session should pass capabilities to other sessions.
      for (let i = 0; i < this.sessions.length; i++) {
        const s = this.sessions[i]
        if (s !== this) s._passCapabilities(this)
      }
    }

    if (!this.sign) this.sign = this.core.defaultSign
    this.writable = !!this.sign

    if (opts.valueEncoding) {
      this.valueEncoding = c.from(codecs(opts.valueEncoding))
    }
    if (opts.encodeBatch) {
      this.encodeBatch = opts.encodeBatch
    }

    // This is a hidden option that's only used by Corestore.
    // It's required so that corestore can load a name from userData before 'ready' is emitted.
    if (opts._preready) await opts._preready(this)

    this.opened = true
    this.emit('ready')
  }

  async _openCapabilities (keyPair, storage, opts) {
    if (opts.from) return this._openFromExisting(opts.from, opts)

    this.storage = Hypercore.defaultStorage(opts.storage || storage)

    this.core = await Core.open(this.storage, {
      createIfMissing: opts.createIfMissing,
      overwrite: opts.overwrite,
      keyPair,
      crypto: this.crypto,
      onupdate: this._oncoreupdate.bind(this)
    })

    if (opts.userData) {
      for (const [key, value] of Object.entries(opts.userData)) {
        await this.core.userData(key, value)
      }
    }

    this.replicator = new Replicator(this.core, {
      onupdate: this._onpeerupdate.bind(this),
      onupload: this._onupload.bind(this)
    })

    this.discoveryKey = this.crypto.discoveryKey(this.core.header.signer.publicKey)
    this.key = this.core.header.signer.publicKey
    this.keyPair = this.core.header.signer

    if (!this.encryption && opts.encryptionKey) {
      this.encryption = new BlockEncryption(opts.encryptionKey, this.key)
    }

    this.extensions.attach(this.replicator)
  }

  close () {
    if (this.closing) return this.closing
    this.closing = this._close()
    return this.closing
  }

  async _close () {
    await this.opening

    const i = this.sessions.indexOf(this)
    if (i === -1) return

    this.sessions.splice(i, 1)
    this.readable = false
    this.writable = false
    this.closed = true
    this.opened = false

    if (this.sessions.length) {
      // if this is the last session and we are auto closing, trigger that first to enforce error handling
      if (this.sessions.length === 1 && this.autoClose) await this.sessions[0].close()
      // emit "fake" close as this is a session
      this.emit('close', false)
      return
    }

    await this.core.close()

    this.emit('close', true)
  }

  replicate (isInitiator, opts = {}) {
    const protocolStream = Hypercore.createProtocolStream(isInitiator, opts)
    const noiseStream = protocolStream.noiseStream
    const protocol = noiseStream.userData

    if (this.opened) {
      this.replicator.joinProtocol(protocol, this.key, this.discoveryKey)
    } else {
      this.opening.then(() => this.replicator.joinProtocol(protocol, this.key, this.discoveryKey), protocol.destroy.bind(protocol))
    }

    return protocolStream
  }

  get length () {
    return this._snapshot
      ? this._snapshot.length
      : (this.core === null ? 0 : this.core.tree.length)
  }

  get byteLength () {
    return this._snapshot
      ? this._snapshot.byteLength
      : (this.core === null ? 0 : this.core.tree.byteLength - (this.core.tree.length * this.padding))
  }

  get fork () {
    return this._snapshot
      ? this._snapshot.fork
      : (this.core === null ? 0 : this.core.tree.fork)
  }

  get peers () {
    return this.replicator === null ? [] : this.replicator.peers
  }

  get encryptionKey () {
    return this.encryption && this.encryption.key
  }

  get padding () {
    return this.encryption === null ? 0 : this.encryption.padding
  }

  ready () {
    return this.opening
  }

  _onupload (index, value, from) {
    const byteLength = value.byteLength - this.padding

    for (let i = 0; i < this.sessions.length; i++) {
      this.sessions[i].emit('upload', index, byteLength, from)
    }
  }

  _oncoreupdate (status, bitfield, value, from) {
    if (status !== 0) {
      for (let i = 0; i < this.sessions.length; i++) {
        if ((status & 0b10) !== 0) {
          if (this.cache) this.cache.clear()
          this.sessions[i].emit('truncate', bitfield.start, this.core.tree.fork)
        }
        if ((status & 0b01) !== 0) {
          this.sessions[i].emit('append')
        }
      }

      this.replicator.broadcastInfo()
    }

    if (bitfield && !bitfield.drop) { // TODO: support drop!
      for (let i = 0; i < bitfield.length; i++) {
        this.replicator.broadcastBlock(bitfield.start + i)
      }
    }

    if (value) {
      const byteLength = value.byteLength - this.padding

      for (let i = 0; i < this.sessions.length; i++) {
        this.sessions[i].emit('download', bitfield.start, byteLength, from)
      }
    }
  }

  _onpeerupdate (added, peer) {
    if (added) this.extensions.update(peer)
    const name = added ? 'peer-add' : 'peer-remove'

    for (let i = 0; i < this.sessions.length; i++) {
      this.sessions[i].emit(name, peer)
    }
  }

  async setUserData (key, value) {
    if (this.opened === false) await this.opening
    return this.core.userData(key, value)
  }

  async getUserData (key) {
    if (this.opened === false) await this.opening
    for (const { key: savedKey, value } of this.core.header.userData) {
      if (key === savedKey) return value
    }
    return null
  }

  async update () {
    if (this.opened === false) await this.opening
    // TODO: add an option where a writer can bootstrap it's state from the network also
    if (this.writable) return false
    return this.replicator.requestUpgrade()
  }

  async seek (bytes) {
    if (this.opened === false) await this.opening

    const s = this.core.tree.seek(bytes, this.padding)

    return (await s.update()) || this.replicator.requestSeek(s)
  }

  async has (index) {
    if (this.opened === false) await this.opening

    return this.core.bitfield.get(index)
  }

  async get (index, opts) {
    if (this.opened === false) await this.opening
    const c = this.cache && this.cache.get(index)
    if (c) return c
    const fork = this.core.tree.fork
    const b = await this._get(index, opts)
    if (this.cache && fork === this.core.tree.fork && b) this.cache.set(index, b)
    return b
  }

  async _get (index, opts) {
    const encoding = (opts && opts.valueEncoding && c.from(codecs(opts.valueEncoding))) || this.valueEncoding

    let block

    if (this.core.bitfield.get(index)) {
      block = await this.core.blocks.get(index)
    } else {
      if (opts && opts.wait === false) return null
      if (opts && opts.onwait) opts.onwait(index)
      block = await this.replicator.requestBlock(index)
    }

    if (this.encryption) this.encryption.decrypt(index, block)
    return this._decode(encoding, block)
  }

  createReadStream (opts) {
    return new ReadStream(this, opts)
  }

  createWriteStream (opts) {
    return new WriteStream(this, opts)
  }

  download (range) {
    const linear = !!(range && range.linear)

    let start
    let end
    let filter

    if (range && range.blocks) {
      const blocks = range.blocks instanceof Set
        ? range.blocks
        : new Set(range.blocks)

      start = range.start || (blocks.size ? min(range.blocks) : 0)
      end = range.end || (blocks.size ? max(range.blocks) + 1 : 0)

      filter = (i) => blocks.has(i)
    } else {
      start = (range && range.start) || 0
      end = typeof (range && range.end) === 'number' ? range.end : -1 // download all
    }

    const r = Replicator.createRange(start, end, filter, linear)

    if (this.opened) this.replicator.addRange(r)
    else this.opening.then(() => this.replicator.addRange(r), noop)

    return r
  }

  // TODO: get rid of this / deprecate it?
  cancel (request) {
    // Do nothing for now
  }

  // TODO: get rid of this / deprecate it?
  undownload (range) {
    range.destroy(null)
  }

  async truncate (newLength = 0, fork = -1) {
    if (this.opened === false) await this.opening
    if (this.writable === false) throw new Error('Core is not writable')

    if (fork === -1) fork = this.core.tree.fork + 1
    await this.core.truncate(newLength, fork, this.sign)

    // TODO: Should propagate from an event triggered by the oplog
    this.replicator.updateAll()
  }

  async append (blocks) {
    if (this.opened === false) await this.opening
    if (this.writable === false) throw new Error('Core is not writable')

    blocks = Array.isArray(blocks) ? blocks : [blocks]

    const preappend = this.encryption && this._preappend

    const buffers = this.encodeBatch !== null ? this.encodeBatch(blocks) : new Array(blocks.length)

    if (this.encodeBatch === null) {
      for (let i = 0; i < blocks.length; i++) {
        buffers[i] = this._encode(this.valueEncoding, blocks[i])
      }
    }

    return await this.core.append(buffers, this.sign, { preappend })
  }

  async treeHash (length) {
    if (length === undefined) {
      await this.ready()
      length = this.core.length
    }

    const roots = await this.core.tree.getRoots(length)
    return this.crypto.tree(roots)
  }

  registerExtension (name, handlers) {
    return this.extensions.register(name, handlers)
  }

  // called by the extensions
  onextensionupdate () {
    if (this.replicator !== null) this.replicator.broadcastOptions()
  }

  _encode (enc, val) {
    const state = { start: this.padding, end: this.padding, buffer: null }

    if (b4a.isBuffer(val)) {
      if (state.start === 0) return val
      state.end += val.byteLength
    } else if (enc) {
      enc.preencode(state, val)
    } else {
      val = b4a.from(val)
      if (state.start === 0) return val
      state.end += val.byteLength
    }

    state.buffer = b4a.allocUnsafe(state.end)

    if (enc) enc.encode(state, val)
    else state.buffer.set(val, state.start)

    return state.buffer
  }

  _decode (enc, block) {
    block = block.subarray(this.padding)
    if (enc) return c.decode(enc, block)
    return block
  }
}

function noop () {}

function isStream (s) {
  return typeof s === 'object' && s && typeof s.pipe === 'function'
}

function requireMaybe (name) {
  try {
    return require(name)
  } catch (_) {
    return null
  }
}

function toHex (buf) {
  return buf && b4a.toString(buf, 'hex')
}

function reduce (iter, fn, acc) {
  for (const item of iter) acc = fn(acc, item)
  return acc
}

function min (arr) {
  return reduce(arr, (a, b) => Math.min(a, b), Infinity)
}

function max (arr) {
  return reduce(arr, (a, b) => Math.max(a, b), -Infinity)
}

function preappend (blocks) {
  const offset = this.core.tree.length
  const fork = this.core.tree.fork

  for (let i = 0; i < blocks.length; i++) {
    this.encryption.encrypt(offset + i, blocks[i], fork)
  }
}
