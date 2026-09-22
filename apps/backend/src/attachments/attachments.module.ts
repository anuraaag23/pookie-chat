import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { GoogleDriveService } from './google-drive.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, GoogleDriveService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
