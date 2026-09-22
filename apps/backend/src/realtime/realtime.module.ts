import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { ConnectionRegistryService } from './connection-registry.service';

@Module({
  providers: [RealtimeGateway, ConnectionRegistryService],
  exports: [ConnectionRegistryService],
})
export class RealtimeModule {}
