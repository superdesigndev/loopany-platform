import { afterEach, expect, test, vi } from 'vitest'
import { CHANNELS, failureMessage, fetchSlackChannels, setWebhookFetchDeps } from './notify'

afterEach(() => {
  setWebhookFetchDeps({}) // restore real DNS + fetch after each seam
  vi.unstubAllGlobals()
})

test('a running run interrupted mid-flight reads as calmly asleep, not a scary failure', () => {
  const m = failureMessage('machine timed out / disconnected')
  expect(m).toMatch(/asleep|offline/i)
  expect(m).toMatch(/in progress|interrupted/i)
  expect(m).toMatch(/resumes automatically/i)
  expect(m).not.toMatch(/📵/) // no alarming "no signal" icon
})

test('a scheduled run skipped while asleep names sleep as the likely cause', () => {
  for (const reason of ['machine offline', 'run never claimed']) {
    const m = failureMessage(reason)
    expect(m).toMatch(/asleep/i)
    expect(m).toMatch(/skipped/i)
    expect(m).toMatch(/resumes automatically/i)
    expect(m).not.toMatch(/📵/)
  }
})

test('a genuine run failure still surfaces the real reason', () => {
  expect(failureMessage('claude reported an error')).toBe('⚠️ Run failed — claude reported an error')
  expect(failureMessage(null)).toBe('⚠️ Run failed.')
})

test("the daemon's exec-timeout is a real failure, not the calm asleep copy", () => {
  const m = failureMessage('claude timed out (30s)')
  expect(m).toBe('⚠️ Run failed — claude timed out (30s)')
  expect(m).not.toMatch(/asleep|resumes automatically/i)
})

// ---- Feishu webhook SSRF guard (create/test gate + send-time DNS/IP guard) ----

const feishu = CHANNELS.feishu

test('feishu.validate (create/test gate) rejects off-allowlist / non-HTTPS / metadata targets', () => {
  // These are exactly what notifyFns.createChannel / testChannel run before storing/firing.
  expect(feishu.validate!({ webhookUrl: 'http://127.0.0.1/open-apis/bot/v2/hook/x' })).toBeTruthy()
  expect(feishu.validate!({ webhookUrl: 'https://10.0.0.5/open-apis/bot/v2/hook/x' })).toBeTruthy()
  expect(feishu.validate!({ webhookUrl: 'https://169.254.169.254/open-apis/bot/v2/hook/x' })).toBeTruthy()
  expect(feishu.validate!({ webhookUrl: 'https://evil.example.com/open-apis/bot/v2/hook/x' })).toBeTruthy()
  expect(feishu.validate!({ webhookUrl: 'http://open.feishu.cn/open-apis/bot/v2/hook/x' })).toBeTruthy()
})

test('feishu.validate accepts an official Feishu/Lark HTTPS webhook', () => {
  expect(feishu.validate!({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' })).toBeNull()
  expect(feishu.validate!({ webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc' })).toBeNull()
})

test('feishu.send re-validates the allowlist at SEND time (stored URL is untrusted)', async () => {
  let fetched = false
  setWebhookFetchDeps({
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: (async () => {
      fetched = true
      return new Response('{}')
    }) as unknown as typeof fetch,
  })
  const r = await feishu.send({ webhookUrl: 'https://internal.corp/open-apis/bot/v2/hook/x' }, 'T', 'M')
  expect(r.ok).toBe(false)
  expect(fetched).toBe(false) // rejected before any network call
})

test('feishu.send rejects an allowlisted host that resolves to a private address', async () => {
  setWebhookFetchDeps({
    lookup: async () => [{ address: '127.0.0.1' }],
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  })
  const r = await feishu.send({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' }, 'T', 'M')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/non-public/)
})

test('feishu.send delivers to an allowlisted host resolving public (network stubbed)', async () => {
  let posted: unknown = null
  setWebhookFetchDeps({
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: (async (_url: string, init: RequestInit) => {
      posted = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  const r = await feishu.send({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' }, 'Title', 'Body')
  expect(r.ok).toBe(true)
  expect(posted).toMatchObject({ msg_type: 'text', content: { text: '🔁 Title\nBody' } })
})

// ---- Slack (bot token + chat.postMessage) ----

const slack = CHANNELS.slack

test('slack.validate accepts a well-formed bot token + channel', () => {
  expect(slack.validate!({ token: 'xoxb-123-456-abc', channel: '#alerts' })).toBeNull()
})

test('slack.validate rejects a token that is not a Slack xox token', () => {
  const err = slack.validate!({ token: 'not-a-slack-token', channel: '#alerts' })
  expect(err).toBeTruthy()
  expect(err).toMatch(/xoxb-/)
})

test('slack.validate rejects an empty/whitespace channel', () => {
  expect(slack.validate!({ token: 'xoxb-123', channel: '' })).toBeTruthy()
  expect(slack.validate!({ token: 'xoxb-123', channel: '   ' })).toBeTruthy()
})

test('slack.send maps not_in_channel to an actionable invite message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 })),
  )
  const r = await slack.send({ token: 'xoxb-123', channel: '#alerts' }, 'T', 'M')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/not_in_channel/)
  expect(r.error).toMatch(/invite/i)
})

test('slack.send maps invalid_auth to an actionable revoked-token message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })),
  )
  const r = await slack.send({ token: 'xoxb-123', channel: '#alerts' }, 'T', 'M')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/invalid_auth/)
  expect(r.error).toMatch(/invalid|revoked/i)
})

test('slack.send converts the message through markdownToMrkdwn and keeps the bold mrkdwn title', async () => {
  let posted: unknown = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posted = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
  const r = await slack.send({ token: 'xoxb-123', channel: '#alerts' }, 'Title', '**bold** text')
  expect(r.ok).toBe(true)
  expect(posted).toMatchObject({ channel: '#alerts', text: '🔁 *Title*\n*bold* text' })
})

// ---- fetchSlackChannels (the add-channel picker's `conversations.list` call) ----

test('fetchSlackChannels rejects a non-xox token without any network call', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const r = await fetchSlackChannels('not-a-token')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/xoxb-/)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('fetchSlackChannels paginates via response_metadata.next_cursor and sorts by name', async () => {
  const pages = [
    { ok: true, channels: [{ id: 'C2', name: 'zeta', is_private: false, is_member: true }], response_metadata: { next_cursor: 'page2' } },
    { ok: true, channels: [{ id: 'C1', name: 'alpha', is_private: true, is_member: false }], response_metadata: { next_cursor: '' } },
  ]
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(pages[call++]), { status: 200 })),
  )
  const r = await fetchSlackChannels('xoxb-123')
  expect(r.ok).toBe(true)
  expect(call).toBe(2)
  expect(r.channels).toEqual([
    { id: 'C1', name: 'alpha', isPrivate: true, isMember: false },
    { id: 'C2', name: 'zeta', isPrivate: false, isMember: true },
  ])
})

test('fetchSlackChannels maps missing_scope to actionable guidance', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), { status: 200 })),
  )
  const r = await fetchSlackChannels('xoxb-123')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/channels:read/)
})

test('fetchSlackChannels maps invalid_auth to actionable guidance', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })),
  )
  const r = await fetchSlackChannels('xoxb-123')
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/invalid_auth/)
  expect(r.error).toMatch(/invalid|revoked/i)
})
