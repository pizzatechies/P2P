package com.pizzatechies.aurex;

import android.content.Intent;
import android.nfc.NfcAdapter;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.pizzatechies.aurex.nfc.AurexNfcPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AurexNfcPlugin.class);
        setIntent(asLink(getIntent()));
        super.onCreate(savedInstanceState);
        // Balances, account numbers and ID photos stay out of screenshots, screen recordings and
        // the recent-apps preview.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(asLink(intent));
    }

    /** A tapped NFC pay link arrives like any other link, so the app opens the pay screen for it. */
    private static Intent asLink(Intent intent) {
        if (intent != null && NfcAdapter.ACTION_NDEF_DISCOVERED.equals(intent.getAction()) && intent.getData() != null) {
            intent.setAction(Intent.ACTION_VIEW);
        }
        return intent;
    }
}
