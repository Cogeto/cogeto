import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route (or controller) as reachable without authentication (FIX-3
 * QS-18). Used ONLY on the four intentionally-public surfaces: `health`,
 * `health/live`, `config`, and `instance/public-key`. Everything else is
 * denied by default once BearerAuthGuard is registered as a global guard — a
 * new controller that forgets to authenticate is closed, not open.
 */
export const IS_PUBLIC_KEY = 'cogeto:is-public';
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);
