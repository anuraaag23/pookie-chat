import { Module } from '@nestjs/common';
import { HandshakeService } from './handshake.service';
import { HandshakeController } from './handshake.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [HandshakeController],
  providers: [HandshakeService],
})
export class HandshakeModule {}
