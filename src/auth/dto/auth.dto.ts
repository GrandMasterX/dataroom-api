import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Request and response shapes. These classes are the API contract: the frontend generates
 * its types from the OpenAPI document produced here, so a missing decorator means the
 * frontend cannot see the field.
 */

const normalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

export class RegisterDto {
  @ApiProperty({ example: 'dana@acme.com' })
  @IsEmail()
  @MaxLength(254)
  @normalizeEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!', minLength: 10 })
  // Length only. Composition rules ("one digit, one symbol") push people toward
  // predictable substitutions without adding much; length is what actually helps.
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password!: string;

  @ApiProperty({ example: 'Dana Owner' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  displayName!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'dana@acme.com' })
  @IsEmail()
  @normalizeEmail()
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MaxLength(200)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Opaque refresh token issued by login or a previous refresh' })
  @IsString()
  @MaxLength(500)
  refreshToken!: string;
}

export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
}

export class SessionDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
  @ApiProperty() accessToken!: string;
  @ApiProperty({ description: 'Store server-side; the browser never sees this directly.' })
  refreshToken!: string;
  @ApiProperty({ description: 'Seconds until the access token expires.' })
  accessTokenExpiresInSeconds!: number;
}
