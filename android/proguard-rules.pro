# Consumer rules shipped to the host application (android/defaultConfig consumerProguardFiles).
#
# The upstream sherpa-onnx AAR ships an EMPTY proguard.txt, and its Kotlin API is reached
# through JNI native methods, so nothing keeps it from being stripped if the host app
# enables R8/minification. Keep the whole API surface.
-keep class com.k2fsa.sherpa.onnx.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
