import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'

// Cloudflare bindings — declared in wrangler.jsonc. Keep this in sync with the
// resources you add (D1, KV, R2, Queues, Workers AI, …).
export type Bindings = {
  DB: D1Database
  ENVIRONMENT: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// Liveness probe — the scaffold's success criterion is `GET /health -> {ok:true}`.
app.get('/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT ?? 'unknown' }))

const echoSchema = z.object({ message: z.string().min(1).max(280) })

app.post('/api/echo', zValidator('json', echoSchema), (c) => {
  const { message } = c.req.valid('json')
  return c.json({ echo: message }, 201)
})

app.notFound((c) => c.json({ error: 'not_found' }, 404))
app.onError((err, c) => {
  console.error('[error]', err)
  return c.json({ error: 'internal_error' }, 500)
})

export default app
