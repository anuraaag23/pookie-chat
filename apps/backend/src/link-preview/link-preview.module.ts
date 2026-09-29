import { Module } from '@nestjs/common';
import { LinkPreviewController } from './link-preview.controller';
import { LinkPreviewService } from './link-preview.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [LinkPreviewController],
  providers: [LinkPreviewService],
  exports: [LinkPreviewService],
})
export class LinkPreviewModule {}
