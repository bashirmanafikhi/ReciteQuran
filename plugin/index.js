const { withInfoPlist, AndroidConfig } = require('expo/config-plugins');

const { withPermissions } = AndroidConfig.Permissions;

const withReciteQuran = (config, props = {}) => {
  // Add Android RECORD_AUDIO permission
  config = withPermissions(config, ['android.permission.RECORD_AUDIO']);

  // Add iOS NSMicrophoneUsageDescription
  config = withInfoPlist(config, (config) => {
    const microphonePermissionDescription =
      props.microphonePermission || 'Allow $(PRODUCT_NAME) to access your microphone for Quran recitation tracking.';
    config.modResults.NSMicrophoneUsageDescription =
      config.modResults.NSMicrophoneUsageDescription || microphonePermissionDescription;
    return config;
  });

  return config;
};

module.exports = withReciteQuran;
