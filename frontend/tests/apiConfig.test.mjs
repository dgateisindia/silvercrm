import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CrmApiConfigurationError,
  parseCrmApiConfiguration,
} from '../src/core/api/apiConfig.ts'

function environment(baseUrl, authMode) {
  return {
    VITE_CRM_API_BASE_URL: baseUrl,
    VITE_CRM_AUTH_MODE: authMode,
  }
}

function expectConfigError(input) {
  assert.throws(
    () => parseCrmApiConfiguration(input),
    (error) => {
      assert.ok(error instanceof CrmApiConfigurationError)
      assert.equal(error.name, 'CrmApiConfigurationError')
      assert.ok(error.message.length > 0)
      return true
    },
  )
}

test('01 - empty environment disables API integration', () => {
  assert.deepEqual(
    parseCrmApiConfiguration({}),
    { status: 'unconfigured' },
  )
})

test('02 - undefined values remain unconfigured', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(environment(undefined, undefined)),
    { status: 'unconfigured' },
  )
})

test('03 - null values remain unconfigured', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(environment(null, null)),
    { status: 'unconfigured' },
  )
})

test('04 - empty values remain unconfigured', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(environment('', '')),
    { status: 'unconfigured' },
  )
})

test('05 - HTTPS cookie configuration is normalized', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('https://api.example.com/v1', 'cookie'),
    ),
    {
      status: 'configured',
      baseUrl: 'https://api.example.com/v1/',
      authMode: 'cookie',
    },
  )
})

test('06 - HTTPS bearer configuration is supported', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('https://api.example.com/v1/', 'bearer'),
    ),
    {
      status: 'configured',
      baseUrl: 'https://api.example.com/v1/',
      authMode: 'bearer',
    },
  )
})

test('07 - HTTP localhost is allowed for local development', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('http://localhost/api', 'cookie'),
    ),
    {
      status: 'configured',
      baseUrl: 'http://localhost/api/',
      authMode: 'cookie',
    },
  )
})

test('08 - HTTP 127.0.0.1 is allowed locally', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('http://127.0.0.1/api', 'bearer'),
    ),
    {
      status: 'configured',
      baseUrl: 'http://127.0.0.1/api/',
      authMode: 'bearer',
    },
  )
})

test('09 - HTTP IPv6 loopback is allowed locally', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('http://[::1]:4400/api', 'cookie'),
    ),
    {
      status: 'configured',
      baseUrl: 'http://[::1]:4400/api/',
      authMode: 'cookie',
    },
  )
})

test('10 - local development custom port is preserved', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('http://localhost:4300/api', 'bearer'),
    ),
    {
      status: 'configured',
      baseUrl: 'http://localhost:4300/api/',
      authMode: 'bearer',
    },
  )
})

test('11 - HTTPS custom port is preserved', () => {
  assert.deepEqual(
    parseCrmApiConfiguration(
      environment('https://api.example.com:8443/api', 'cookie'),
    ),
    {
      status: 'configured',
      baseUrl: 'https://api.example.com:8443/api/',
      authMode: 'cookie',
    },
  )
})

test('12 - missing API URL is rejected', () => {
  expectConfigError(
    environment(undefined, 'bearer'),
  )
})

test('13 - missing authentication mode is rejected', () => {
  expectConfigError(
    environment('https://api.example.com/api/', undefined),
  )
})

test('14 - unsupported authentication mode is rejected', () => {
  expectConfigError(
    environment('https://api.example.com/api/', 'anonymous'),
  )
})

test('15 - authentication mode is case-sensitive', () => {
  expectConfigError(
    environment('https://api.example.com/api/', 'Bearer'),
  )
})

test('16 - API URL with leading whitespace is rejected', () => {
  expectConfigError(
    environment(' https://api.example.com/api/', 'cookie'),
  )
})

test('17 - API URL with trailing whitespace is rejected', () => {
  expectConfigError(
    environment('https://api.example.com/api/ ', 'cookie'),
  )
})

test('18 - authentication mode with whitespace is rejected', () => {
  expectConfigError(
    environment('https://api.example.com/api/', ' cookie '),
  )
})

test('19 - whitespace-only API URL is rejected', () => {
  expectConfigError(
    environment('   ', 'cookie'),
  )
})

test('20 - non-string API URL is rejected', () => {
  expectConfigError(
    environment(1234, 'cookie'),
  )
})

test('21 - non-string authentication mode is rejected', () => {
  expectConfigError(
    environment('https://api.example.com/api/', true),
  )
})

test('22 - null environment object is rejected', () => {
  expectConfigError(null)
})

test('23 - undefined environment object is rejected', () => {
  expectConfigError(undefined)
})

test('24 - string environment value is rejected', () => {
  expectConfigError('invalid environment')
})

test('25 - malformed URL is rejected', () => {
  expectConfigError(
    environment('not-a-valid-url', 'cookie'),
  )
})

test('26 - insecure remote HTTP API is rejected', () => {
  expectConfigError(
    environment('http://api.example.com/v1/', 'cookie'),
  )
})

test('27 - unsupported FTP URL is rejected', () => {
  expectConfigError(
    environment('ftp://api.example.com/v1/', 'bearer'),
  )
})

test('28 - credentials in API URL are rejected', () => {
  expectConfigError(
    environment(
      'https://username:password@api.example.com/v1/',
      'cookie',
    ),
  )
})

test('29 - query parameters in API URL are rejected', () => {
  expectConfigError(
    environment(
      'https://api.example.com/v1/?token=example',
      'bearer',
    ),
  )
})

test('30 - fragments in API URL are rejected', () => {
  expectConfigError(
    environment(
      'https://api.example.com/v1/#section',
      'cookie',
    ),
  )
})