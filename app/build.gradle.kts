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
    kotlinOptions {
        jvmTarget = "17"
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

    // Solana — wallet real (keypair, saldo, transferências)
    implementation("org.sol4k:sol4k:0.7.0")
    
    // NOVO WEBRTC: Mantido ativamente pela GetStream no Maven Central.
    // É um "drop-in replacement", ou seja, usa os mesmos imports org.webrtc.* no código!
    implementation("io.getstream:stream-webrtc-android:1.2.1")

    // NOVO BIP39: A NovaCrypto morreu. Esta é uma biblioteca Web3 padrão 
    // que contém a classe MnemonicUtils para gerar as 12 palavras perfeitamente.
    implementation("org.web3j:crypto:4.8.7")

    // Ed25519 puro-Java, só usado pra expandir seed(32) -> par de chaves (SLIP-0010)
    implementation("net.i2p.crypto:eddsa:0.3.0")
}
