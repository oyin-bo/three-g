// @ts-check

/**
 * @param {number} code
 * @param {WebGLRenderingContext} [gl]
 */
export function glCode(code, gl) {
  const useGL = gl || WebGLRenderingContext;
  for (const k in useGL) {
    if (useGL[k] === code) return k;
  }

  return 'ERR:0x' + code.toString(16).toUpperCase();
}

/**
 * @param {WebGLRenderingContext} gl
 */
export function glErrorString(gl) {
  const code = gl.getError();
  return glCode(code, gl);
}

/**
 * @param {{
 *  gl: WebGLRenderingContext,
 *  shader: WebGLShader,
 *  type: number,
 *  source: string
 * }} _
 */
export function glErrorShaderCompilationString({ gl, shader, type, source }) {
  const errorLog = gl.getShaderInfoLog(shader);
  if (!errorLog) return glCode(type) + ' compliation error (no log).';

  const errorLines = errorLog.split('\n');
  const lineNumberRegex = /:(\d+):/;
  let formattedError = glCode(type) + ' compilation error:\n';

  errorLines.forEach(errorLine => {
    const match = errorLine.match(lineNumberRegex);
    if (match) {
      const lineNumber = parseInt(match[1]);
      const lines = source.split('\n');
      const startLine = Math.max(0, lineNumber - 3);
      const endLine = Math.min(lines.length, lineNumber + 2);

      formattedError += '\n' + errorLine + '\n';
      for (let i = startLine; i < endLine; i++) {
        const ln = lines[i];
        if (i + 1 === lineNumber) {
          const trimedStart = ln.trimStart();
          const leadSpaceCount = ln.length - trimedStart.length;
          formattedError += (i + 1) + '>>' + Array(leadSpaceCount - 1).fill('>').join('') + ' ' + trimedStart + '\n';
        } else {
          formattedError += (i + 1) + ': ' + ln + '\n';
        }
      }
    } else if (errorLine.trim() !== '') {
      formattedError += `${errorLine}\n`;
    }
  });

  return formattedError;
}


export function glErrorProgramLinkingString({ gl, program }) {
  const genericError = glErrorString(gl);
  const errorLog = gl.getProgramInfoLog(program);
  if (!errorLog) return 'Program linking ' + genericError + ' (no log).';

  return 'Program linking ' + genericError + ':\n' + errorLog;
}