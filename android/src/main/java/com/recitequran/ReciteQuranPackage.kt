package com.recitequran

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Autolinking entry point — React Native discovers this through `react-native.config.js`
 * conventions / the `android/` folder of the published npm package, so Task 12 only has to
 * reach for `NativeModules.ReciteQuran`.
 */
class ReciteQuranPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(ReciteQuranModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
