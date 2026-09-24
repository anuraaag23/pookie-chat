import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AccessTokenGuard } from './access-token.guard';
import { GoogleAuthService } from './google-auth.service';
import { TurnstileService } from './turnstile.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [RealtimeModule, EmailModule],
  controllers: [AuthController],
  providers: [AuthService, GoogleAuthService, AccessTokenGuard, TurnstileService],
  exports: [AuthService, GoogleAuthService, AccessTokenGuard, TurnstileService],
})
export class AuthModule {}
