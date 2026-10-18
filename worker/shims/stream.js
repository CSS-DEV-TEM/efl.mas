// postgres.js only uses streams for COPY / large objects, which this app never calls.
class NotUsed { constructor() { throw new Error('Streams are not available in this Worker.'); } }
export const Readable = NotUsed, Writable = NotUsed, Duplex = NotUsed, Transform = NotUsed, PassThrough = NotUsed;
export default { Readable, Writable, Duplex, Transform, PassThrough };
