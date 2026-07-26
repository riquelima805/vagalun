plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.decentstorage.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.decentstorage.app"
        minSdk = 26 // precisa de 26+ por causa de NsdManager/APIs de crypto usadas
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-mvp"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    
    // 🔧 SINTAXE NOVA PARA KOTLIN 2.2 (Igual ao seu app Adla)
    kotlin {
        compilerOptions {
            // Mantido em JVM_17 porque o Jetpack Compose exige Java 17
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
            languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
            apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
        }
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.material3:material3:1.2.1")
    implementation("androidx.compose.ui:ui:1.6.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Adicionado o Material Design para resolver o erro do Manifest
    implementation("com.google.android.material:material:1.12.0")

    // Solana — Atualizado para 0.8.2 (Igual ao Adla)
    implementation("org.sol4k:sol4k:0.8.2")
    
    // NOVO WEBRTC: Mantido ativamente pela GetStream no Maven Central
    implementation("io.getstream:stream-webrtc-android:1.2.1")

    // Web3j — Atualizado para 4.10.0 (Igual ao Adla)
    implementation("org.web3j:core:4.10.0")

    // Ed25519 puro-Java, só usado pra expandir seed(32) -> par de chaves (SLIP-0010)
    implementation("net.i2p.crypto:eddsa:0.3.0")
}
