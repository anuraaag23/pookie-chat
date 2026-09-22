import { Module, forwardRef } from '@nestjs/common';
import { ManagedStorageProvider } from './managed-storage.provider';
import { UserDriveStorageProvider } from './user-drive-storage.provider';
import { GoogleDriveOAuthService } from './google-drive-oauth.service';
import { GoogleDriveOAuthController } from './google-drive-oauth.controller';
import { GoogleDriveService } from '../attachments/google-drive.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [GoogleDriveOAuthController],
  providers: [
    GoogleDriveService,
    ManagedStorageProvider,
    UserDriveStorageProvider,
    GoogleDriveOAuthService,
  ],
  exports: [
    GoogleDriveService,
    ManagedStorageProvider,
    UserDriveStorageProvider,
    GoogleDriveOAuthService,
  ],
})
export class StorageModule {}
