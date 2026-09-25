/**
 * A bounded, actionable failure reported to the client.
 *
 * The message is the whole payload: never a stacktrace, a token, a host path,
 * or mail content the caller did not already supply.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError'
}

/** A configuration failure raised before the server begins serving. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Google refused the stored refresh token, or there is none. Terminal: the
 * owner has to run `google-mcp auth` again. Nothing retries it.
 */
export class ReconnectError extends ToolError {
  constructor(reason: string) {
    super(`reconnect Google: ${reason}; run \`google-mcp auth\` on the box`)
  }
}
