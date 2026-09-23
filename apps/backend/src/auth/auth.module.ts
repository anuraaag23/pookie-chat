import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AccessTokenGuard } from './access-token.guard';
import { GoogleAuthService } from './google-auth.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [RealtimeModule, EmailModule],
  controllers: [AuthController],
  providers: [AuthService, GoogleAuthService, AccessTokenGuard],
  exports: [AuthService, GoogleAuthService, AccessTokenGuard],
})
export class AuthModule {}
