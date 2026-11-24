package com.pizzatechies.aurex.nfc;

import android.nfc.cardemulation.HostApduService;
import android.os.Bundle;

/**
 * Answers the other phone's NFC reader while "Tap to get paid" is open in Aurex, presenting the
 * customer's pay link as a read-only NFC tag. Nothing is shared when no link is set.
 */
public class PayLinkHceService extends HostApduService {
    private static volatile NdefTag current;
    private NdefTag.Session session;
    private NdefTag sessionTag;

    static void share(String url) {
        current = new NdefTag(url);
    }

    static void stop() {
        current = null;
    }

    static boolean isSharing() {
        return current != null;
    }

    @Override
    public byte[] processCommandApdu(byte[] apdu, Bundle extras) {
        NdefTag tag = current;
        if (tag == null) return NdefTag.NOT_FOUND;
        if (session == null || sessionTag != tag) {
            session = tag.newSession();
            sessionTag = tag;
        }
        return session.process(apdu);
    }

    @Override
    public void onDeactivated(int reason) {
        session = null;
        sessionTag = null;
    }
}
