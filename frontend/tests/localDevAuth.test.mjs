import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/*
 * Execute the actual localDevAuth source with a simulated
 * Vite DEV flag, entirely in memory.
 *
 * No source files or environment files are modified.
 * No network requests or real credentials are used.
 */

const source = readFileSync(
  new URL('../src/core/auth/localDevAuth.ts', import.meta.url),
  'utf8',
)

assert.match(
  source,
  /import\.meta\.env\.DEV\s*!==\s*true/,
)

assert.equal(
  (source.match(/import\.meta\.env\.DEV/g) ?? []).length,
  1,
)

const testableSource = `
let __devMode = true
export function __testSetDevMode(value) {
  __devMode = value
}
${source.replace('import.meta.env.DEV', '__devMode')}
`

const compiled = ts.transpileModule(
  testableSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText

const testModuleUrl =
  'data:text/javascript;base64,' +
  Buffer.from(compiled).toString('base64')

const {
  createLocalDevAuthSession,
  LocalDevAuthError,
  __testSetDevMode,
} = await import(testModuleUrl)

function expectAuthError(action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof LocalDevAuthError)
    assert.equal(error.name, 'LocalDevAuthError')
    assert.ok(error.message.length > 0)
    return true
  })
}

test('01 - creates local development session', () => {
  const session = createLocalDevAuthSession()

  assert.ok(session)
  assert.equal(typeof session.setToken, 'function')
  assert.equal(typeof session.getToken, 'function')
  assert.equal(typeof session.clearToken, 'function')
  assert.equal(typeof session.hasToken, 'function')
})

test('02 - new session has null token', async () => {
  const session = createLocalDevAuthSession()

  assert.equal(await session.getToken(), null)
})

test('03 - new session hasToken is false', () => {
  const session = createLocalDevAuthSession()

  assert.equal(session.hasToken(), false)
})

test('04 - getToken returns a Promise', async () => {
  const session = createLocalDevAuthSession()
  const result = session.getToken()

  assert.ok(result instanceof Promise)
  assert.equal(await result, null)
})

test('05 - stores valid token in memory', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('test-token-001')

  assert.equal(
    await session.getToken(),
    'test-token-001',
  )
})

test('06 - preserves exact valid token', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('AbC_123.test-token')

  assert.equal(
    await session.getToken(),
    'AbC_123.test-token',
  )
})

test('07 - hasToken becomes true after setToken', () => {
  const session = createLocalDevAuthSession()

  session.setToken('test-token')

  assert.equal(session.hasToken(), true)
})

test('08 - replacing token updates the current value', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('first-token')
  session.setToken('second-token')

  assert.equal(
    await session.getToken(),
    'second-token',
  )
})

test('09 - clearToken removes token', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('test-token')
  session.clearToken()

  assert.equal(await session.getToken(), null)
})

test('10 - hasToken becomes false after clearToken', () => {
  const session = createLocalDevAuthSession()

  session.setToken('test-token')
  session.clearToken()

  assert.equal(session.hasToken(), false)
})

test('11 - clearing an empty session is allowed', async () => {
  const session = createLocalDevAuthSession()

  session.clearToken()
  session.clearToken()

  assert.equal(await session.getToken(), null)
})

test('12 - separate sessions isolate tokens', async () => {
  const first = createLocalDevAuthSession()
  const second = createLocalDevAuthSession()

  first.setToken('first-test-token')
  second.setToken('second-test-token')

  assert.equal(
    await first.getToken(),
    'first-test-token',
  )

  assert.equal(
    await second.getToken(),
    'second-test-token',
  )
})

test('13 - clearing one session preserves another', async () => {
  const first = createLocalDevAuthSession()
  const second = createLocalDevAuthSession()

  first.setToken('first-test-token')
  second.setToken('second-test-token')

  first.clearToken()

  assert.equal(await first.getToken(), null)
  assert.equal(
    await second.getToken(),
    'second-test-token',
  )
})

test('14 - rejects empty string token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(() => session.setToken(''))
  assert.equal(session.hasToken(), false)
})

test('15 - rejects whitespace-only token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(() => session.setToken('    '))
})

test('16 - rejects leading whitespace', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken(' test-token'),
  )
})

test('17 - rejects trailing whitespace', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken('test-token '),
  )
})

test('18 - rejects embedded spaces', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken('test token'),
  )
})

test('19 - rejects tab characters', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken('test\ttoken'),
  )
})

test('20 - rejects newline characters', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken('test\ntoken'),
  )
})

test('21 - rejects null token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken(null),
  )
})

test('22 - rejects undefined token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken(undefined),
  )
})

test('23 - rejects numeric token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken(12345),
  )
})

test('24 - rejects object token', () => {
  const session = createLocalDevAuthSession()

  expectAuthError(
    () => session.setToken({ token: 'test' }),
  )
})

test('25 - invalid token does not replace valid token', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('valid-test-token')

  expectAuthError(
    () => session.setToken('bad token'),
  )

  assert.equal(
    await session.getToken(),
    'valid-test-token',
  )
})

test('26 - session methods work when called separately', async () => {
  const session = createLocalDevAuthSession()

  const { setToken, getToken, clearToken, hasToken } = session

  setToken('detached-test-token')

  assert.equal(hasToken(), true)
  assert.equal(
    await getToken(),
    'detached-test-token',
  )

  clearToken()

  assert.equal(hasToken(), false)
})

test('27 - session interface is frozen', () => {
  const session = createLocalDevAuthSession()

  assert.equal(Object.isFrozen(session), true)

  assert.throws(
    () => {
      session.hasToken = () => true
    },
    TypeError,
  )
})

test('28 - production mode blocks session creation', () => {
  __testSetDevMode(false)

  try {
    expectAuthError(
      () => createLocalDevAuthSession(),
    )
  } finally {
    __testSetDevMode(true)
  }
})

test('29 - nontrue development flags block creation', () => {
  for (const mode of [
    undefined,
    null,
    'true',
    0,
  ]) {
    __testSetDevMode(mode)

    try {
      expectAuthError(
        () => createLocalDevAuthSession(),
      )
    } finally {
      __testSetDevMode(true)
    }
  }
})

test('30 - production mode blocks all session methods', async () => {
  const session = createLocalDevAuthSession()

  session.setToken('temporary-test-token')

  __testSetDevMode(false)

  try {
    expectAuthError(
      () => session.setToken('another-test-token'),
    )

    await assert.rejects(
      () => session.getToken(),
      (error) => error instanceof LocalDevAuthError,
    )

    expectAuthError(
      () => session.clearToken(),
    )

    expectAuthError(
      () => session.hasToken(),
    )
  } finally {
    __testSetDevMode(true)
    session.clearToken()
  }
})