import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { hashPassword } from 'better-auth/crypto'
import { z } from 'zod'
import { getConfig } from './config.ts'
import { getDatabase } from './db.ts'
import * as schema from './schema.ts'

function createAuth() {
  const config = getConfig()
  return betterAuth({
    database: drizzleAdapter(getDatabase().db, { provider: 'pg', schema }),
    baseURL: config.appUrl,
    secret: config.authSecret,
    trustedOrigins: [config.appUrl],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    // api.ts enforces shared and per-email database limits. No proxy IP is trusted yet.
    rateLimit: { enabled: false },
  })
}

let auth: ReturnType<typeof createAuth> | undefined

export function getAuth() {
  return (auth ??= createAuth())
}

export class FoundationError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FoundationError'
    this.status = status
  }
}

const claimInput = z.object({
  token: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).email(),
  password: z.string().min(12).max(128),
  workspaceName: z.string().trim().max(120)
    .transform((value) => value || 'My workspace')
    .default('My workspace'),
}).strict()

export async function claimInstallation(input: {
  token: string
  name: string
  email: string
  password: string
  workspaceName: string
}): Promise<void> {
  const result = claimInput.safeParse(input)
  if (!result.success) {
    throw new FoundationError(400, 'Check your setup details. Use a valid email and a password between 12 and 128 characters.')
  }

  const details = result.data
  const expectedToken = getConfig().bootstrapToken
  const providedDigest = createHash('sha256').update(details.token).digest()
  const expectedDigest = createHash('sha256').update(expectedToken).digest()
  if (!expectedToken || !timingSafeEqual(providedDigest, expectedDigest)) {
    throw new FoundationError(403, 'The setup token is not valid.')
  }

  const client = await getDatabase().pool.connect()
  try {
    await client.query('BEGIN')
    const installation = await client.query<{ claimed: boolean }>(
      'SELECT claimed FROM installation WHERE id = $1 FOR UPDATE', ['instance'],
    )
    if (!installation.rows[0]) {
      throw new FoundationError(503, 'Setup is unavailable. Apply database migrations and try again.')
    }
    if (installation.rows[0].claimed) {
      throw new FoundationError(409, 'Setup is complete. Sign in with the owner account.')
    }

    // Use Better Auth's own hash format and credential identity conventions.
    const password = await hashPassword(details.password)
    const userId = randomUUID()
    const workspaceId = randomUUID()
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, now(), now())`,
      [userId, details.name, details.email],
    )
    await client.query(
      `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, password],
    )
    await client.query(
      'INSERT INTO workspace (id, name, created_at) VALUES ($1, $2, now())',
      [workspaceId, details.workspaceName],
    )
    await client.query(
      "INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    )
    await client.query('UPDATE installation SET claimed = true WHERE id = $1', ['instance'])
    await client.query('COMMIT')
  } catch (error) {
    // The caller returns a generic failure for unexpected database errors.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
