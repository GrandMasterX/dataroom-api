import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './access-context';
import { RequireUser } from './access-context.guard';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto, SessionDto, UserDto } from './dto/auth.dto';

/**
 * Tokens are returned in the response body rather than set as cookies. The browser never
 * calls this API directly — the frontend's BFF holds the tokens and keeps them in
 * first-party httpOnly cookies. That removes the cross-site cookie problem entirely and
 * keeps this service free of cookie handling.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Tighter than the global limit: these are the endpoints worth guessing at.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create an account and start a session' })
  @ApiOkResponse({ type: SessionDto })
  register(@Body() dto: RegisterDto): Promise<SessionDto> {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SessionDto })
  login(@Body() dto: LoginDto): Promise<SessionDto> {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Rotates the token. A token presented long after it was rotated is treated as reuse and ends every session for that user; presenting it within the grace window is treated as a concurrent refresh and simply issues a new pair.',
  })
  @ApiOkResponse({ type: SessionDto })
  refresh(@Body() dto: RefreshDto): Promise<SessionDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @RequireUser()
  @ApiOkResponse({ type: UserDto })
  me(@CurrentUser() user: { id: string }): Promise<UserDto> {
    return this.auth.currentUser(user.id);
  }
}
