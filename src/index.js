'use strict'

const Fastify = require('fastify')
const { fetch } = require('undici')
const promClient = require('prom-client')

// --- Métricas ---
promClient.collectDefaultMetrics()
const httpDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
})
const upstreamErrors = new promClient.Counter({
  name: 'upstream_errors_total',
  help: 'Total de erros em chamadas para serviços upstream',
  labelNames: ['service']
})

// --- App ---
const app = Fastify({ logger: true })

const CATALOG_URL = process.env.CATALOG_URL || 'http://app-catalog:3000'
const REVIEWS_URL = process.env.REVIEWS_URL || 'http://app-reviews:3000'

async function fetchJson (url, service) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  } catch (err) {
    upstreamErrors.labels(service).inc()
    app.log.warn({ err, url }, `upstream ${service} error`)
    return null
  }
}

app.addHook('onResponse', (req, reply, done) => {
  httpDuration
    .labels(req.method, req.routeOptions?.url ?? req.url, reply.statusCode)
    .observe(reply.elapsedTime / 1000)
  done()
})

// --- Rotas de plataforma ---
app.get('/health', async () => ({ status: 'ok' }))

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', promClient.register.contentType)
  return promClient.register.metrics()
})

// --- Rotas BFF ---
app.get('/items', async (req, reply) => {
  const items = await fetchJson(`${CATALOG_URL}/items`, 'catalog')
  if (!items) return reply.status(503).send({ error: 'catalog unavailable' })
  return items
})

app.get('/items/:id', async (req, reply) => {
  const { id } = req.params

  // Chama catalog e reviews em paralelo — reviews é opcional
  const [item, reviews] = await Promise.all([
    fetchJson(`${CATALOG_URL}/items/${id}`, 'catalog'),
    fetchJson(`${REVIEWS_URL}/reviews/${id}`, 'reviews')
  ])

  if (!item) return reply.status(503).send({ error: 'catalog unavailable' })
  if (item.error) return reply.status(404).send(item)

  return { ...item, reviews: reviews ?? [] }
})

// --- Start ---
const start = async () => {
  await app.listen({ port: parseInt(process.env.PORT ?? '3000'), host: '0.0.0.0' })
}

start().catch(err => {
  app.log.error(err)
  process.exit(1)
})
