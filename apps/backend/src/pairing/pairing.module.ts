import { Module } from '@nestjs/common';
import { PairingService } from './pairing.service';
import { PairingController } from './pairing.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PairingController],
  providers: [PairingService],
})
export class PairingModule {}
