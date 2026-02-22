import { Transform } from 'node:stream';
import sax from 'sax';

type StreamCounters = {
  accepted: number;
  duplicate: number;
  invalid: number;
  failed: number;
};

export const createNdjsonParseTransform = (counters: StreamCounters): Transform => {
  let buffer = '';

  return new Transform({
    readableObjectMode: true,
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          this.push(JSON.parse(trimmed));
        } catch {
          counters.invalid += 1;
        }
      }

      callback();
    },
    flush(callback) {
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          this.push(JSON.parse(trimmed));
        } catch {
          counters.invalid += 1;
        }
      }
      callback();
    },
    highWaterMark: 32,
  });
};

export const createXmlParseTransform = (counters: StreamCounters): Transform => {
  const parser = sax.parser(true, { trim: true });

  let currentEvent: Record<string, unknown> | null = null;
  let currentTag = '';

  const transform = new Transform({
    readableObjectMode: true,
    transform(chunk, _encoding, callback) {
      try {
        parser.write(chunk.toString('utf8'));
        callback();
      } catch {
        counters.invalid += 1;
        callback();
      }
    },
    flush(callback) {
      try {
        parser.close();
        callback();
      } catch {
        counters.invalid += 1;
        callback();
      }
    },
    highWaterMark: 32,
  });

  parser.onopentag = (node) => {
    currentTag = node.name.toLowerCase();
    if (currentTag === 'event') {
      currentEvent = {};
    }
  };

  parser.ontext = (text) => {
    if (!currentEvent || !currentTag || currentTag === 'event') {
      return;
    }

    if (currentTag === 'payload') {
      try {
        currentEvent.payload = JSON.parse(text);
      } catch {
        currentEvent.payload = { raw: text };
      }
      return;
    }

    currentEvent[currentTag] = text;
  };

  parser.onclosetag = (tagName) => {
    if (tagName.toLowerCase() === 'event' && currentEvent) {
      transform.push(currentEvent);
      currentEvent = null;
    }
  };

  parser.onerror = () => {
    counters.invalid += 1;
    parser.resume();
  };

  return transform;
};

export type { StreamCounters };
