
const util = require('util');

const stream = require('stream');
const fs = require('fs');
const ev = require('events');


// import * as util from 'util';
// import * as stream from 'stream';
// import * as fs from 'fs';
// import {once} from 'events';

const finished = util.promisify(stream.finished);



const appendArrayToFile = async (iterable, filePath) => {
  const writable = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'a' });
  for await (const chunk of iterable) {
    if (!writable.write(chunk + '\n')) {
      // Handle backpressure
      await ev.once(writable, 'drain');
    }
  }
  writable.end();

  // Wait until done. Throws if there are errors.
  await finished(writable);
}

module.exports = appendArrayToFile;