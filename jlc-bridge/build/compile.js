// 打包扩展：src/index.ts → dist/index.js。
//
// src/config.ts 的 CODE_BUILD 是「版本号+代码哈希」，link.ts 靠它发现
// 「globalThis 上的链路状态是上一版代码留下的」并推倒重连，所以它必须跟着代码变。
// 做法：先把 __CODE_HASH__ 定义成空串打一遍，对产物取 SHA-256，再把哈希定义进去正式打一遍。
// 源码不变时哈希不变；改了代码，版本号不动哈希也会变。
//
//   node build/compile.js          打包一次
//   node build/compile.js --watch  源码一改就重新打包

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectDir = path.join(__dirname, '..');
const outfile = path.join(projectDir, 'dist', 'index.js');

const baseOptions = {
  // 产物里每个模块前有一行路径注释，路径相对于工作目录；固定下来，从哪个目录构建哈希都一样
  absWorkingDir: projectDir,
  entryPoints: [path.join(projectDir, 'src', 'index.ts')],
  bundle: true,
  outfile,
  format: 'iife',
  platform: 'browser',
  globalName: 'edaEsbuildExportName',
  target: 'es2018',
  logLevel: 'warning',
  write: false,
};

function codeHashOf(probeCode) {
  return crypto.createHash('sha256').update(probeCode).digest('hex').slice(0, 12);
}

function singleOutput(outputFiles) {
  if (outputFiles.length !== 1) {
    throw new Error(`expected exactly one output file, got ${outputFiles.map((f) => f.path).join(', ')}`);
  }
  return outputFiles[0].text;
}

async function bundle(options, codeHash) {
  const result = await esbuild.build({
    ...options,
    define: { __CODE_HASH__: JSON.stringify(codeHash) },
  });
  return singleOutput(result.outputFiles);
}

/**
 * 打包并注入代码哈希，只返回产物，不落盘。
 * extraOptions 并进 esbuild 的选项，测试用它（比如加一行 banner）模拟改过代码的下一版。
 */
async function compile(extraOptions = {}) {
  const options = { ...baseOptions, ...extraOptions };
  const codeHash = codeHashOf(await bundle(options, ''));
  return { codeHash, code: await bundle(options, codeHash) };
}

function writeOutput(code, codeHash) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, code, { encoding: 'utf8' });
  console.log(`compiled: ${outfile} (code hash ${codeHash})`);
}

async function watch() {
  // context 这一遍就是「__CODE_HASH__ 为空串」的那一遍，每次重新打包完在 onEnd 里取哈希、再正式打一遍
  const context = await esbuild.context({
    ...baseOptions,
    define: { __CODE_HASH__: JSON.stringify('') },
    plugins: [
      {
        name: 'code-hash',
        setup(build) {
          build.onEnd(async (result) => {
            // 出错时 esbuild 已经把错误打在终端上了，等下一次改动再打包
            if (result.errors.length > 0) return;
            const codeHash = codeHashOf(singleOutput(result.outputFiles));
            writeOutput(await bundle(baseOptions, codeHash), codeHash);
          });
        },
      },
    ],
  });
  await context.watch();
  console.log('watching jlc-bridge/src ...');
}

async function main() {
  if (process.argv.includes('--watch')) {
    await watch();
    return;
  }
  const { code, codeHash } = await compile();
  writeOutput(code, codeHash);
}

module.exports = { compile };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
