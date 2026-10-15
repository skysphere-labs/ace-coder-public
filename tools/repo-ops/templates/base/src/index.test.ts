import { describe, expect, it } from 'vitest'
import app from './index'

const env = { ENVIRONMENT: 'test' } as const

describe('api', () => {
  it('GET /health -> {ok:true}', async () => {
    const res = await app.request('/health', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('POST /api/echo validates and echoes', async () => {
    const res = await app.request(
      '/api/echo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      },
      env,
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ echo: 'hi' })
  })

  it('POST /api/echo rejects empty message', async () => {
    const res = await app.request(
      '/api/echo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })
})
