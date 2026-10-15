import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Drizzle schema for D1 (SQLite at the edge). Generate migrations with
// `pnpm db:generate`; apply with `wrangler d1 migrations apply <db>`.
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  },
  (table) => [index('idx_items_created_at').on(table.createdAt)],
)

export type Item = typeof items.$inferSelect
export type NewItem = typeof items.$inferInsert
