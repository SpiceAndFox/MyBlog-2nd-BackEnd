class SseDataParser {
  constructor() {
    this.buffer = "";
    this.dataLines = [];
  }

  dispatch(events) {
    if (!this.dataLines.length) return;
    events.push(this.dataLines.join("\n"));
    this.dataLines = [];
  }

  consumeLine(line, events) {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") return;
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.dataLines.push(value);
  }

  push(text, { eof = false } = {}) {
    this.buffer += String(text || "");
    const events = [];
    while (this.buffer.length) {
      const lf = this.buffer.indexOf("\n");
      const cr = this.buffer.indexOf("\r");
      let index = -1;
      if (lf !== -1 && cr !== -1) index = Math.min(lf, cr);
      else index = Math.max(lf, cr);
      if (index === -1) break;
      const newline = this.buffer[index];
      if (newline === "\r" && index === this.buffer.length - 1 && !eof) break;
      const line = this.buffer.slice(0, index);
      const width = newline === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(index + width);
      this.consumeLine(line, events);
    }
    if (eof) {
      if (this.buffer.length) this.consumeLine(this.buffer, events);
      this.buffer = "";
      this.dispatch(events);
    }
    return events;
  }
}

async function* iterateSseData(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  const parser = new SseDataParser();
  for await (const chunk of body) {
    for (const data of parser.push(decoder.decode(chunk, { stream: true }))) yield data;
  }
  for (const data of parser.push(decoder.decode(), { eof: true })) yield data;
}

module.exports = { SseDataParser, iterateSseData };
