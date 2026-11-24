package com.pizzatechies.aurex.nfc;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.nfc.FormatException;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.cardemulation.CardEmulation;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;

/**
 * NFC for pay links: share yours by holding phones together (host card emulation), write it to an
 * NFC sticker for a stall or a counter, and read one to pay. Only https links are shared or written;
 * the web layer decides which links it will open.
 */
@CapacitorPlugin(name = "AurexNfc")
public class AurexNfcPlugin extends Plugin {
    private static final int READER_FLAGS = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
        | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V;
    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending;
    private NdefMessage toWrite;
    private boolean lockAfterWrite;
    private final Runnable stopShare = this::stopSharingNow;

    private NfcAdapter adapter() {
        return NfcAdapter.getDefaultAdapter(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        NfcAdapter a = adapter();
        boolean hce = a != null && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION);
        JSObject r = new JSObject();
        r.put("supported", a != null);
        r.put("enabled", a != null && a.isEnabled());
        r.put("canShare", hce);
        r.put("canRead", a != null);
        r.put("canWrite", a != null);
        r.put("sharing", PayLinkHceService.isSharing());
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Present the pay link to phones that touch this one, until stopped or `seconds` pass. */
    @PluginMethod
    public void share(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) { call.reject("Only https links can be shared", "invalid_link"); return; }
        NfcAdapter a = adapter();
        if (a == null) { call.reject("This phone has no NFC", "unavailable"); return; }
        if (!a.isEnabled()) { call.reject("Turn on NFC in your phone's settings", "disabled"); return; }
        try {
            PayLinkHceService.share(url);
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "invalid_link");
            return;
        }
        Activity activity = getActivity();
        // While Aurex is open, it answers taps ahead of any other app that emulates a tag.
        try {
            CardEmulation.getInstance(a).setPreferredService(activity, new ComponentName(activity, PayLinkHceService.class));
        } catch (RuntimeException ignored) {
            // Some phones don't allow a preferred service; the system's default still answers.
        }
        int seconds = Math.max(10, Math.min(600, call.getInt("seconds", 120)));
        main.removeCallbacks(stopShare);
        main.postDelayed(stopShare, seconds * 1000L);
        call.resolve();
    }

    @PluginMethod
    public void stopSharing(PluginCall call) {
        stopSharingNow();
        call.resolve();
    }

    private void stopSharingNow() {
        boolean was = PayLinkHceService.isSharing();
        PayLinkHceService.stop();
        main.removeCallbacks(stopShare);
        NfcAdapter a = adapter();
        Activity activity = getActivity();
        if (a != null && activity != null) {
            try {
                CardEmulation.getInstance(a).unsetPreferredService(activity);
            } catch (RuntimeException ignored) {
                // Nothing to undo.
            }
        }
        if (was) notifyListeners("shareStopped", new JSObject());
    }

    /** Wait for a tag (or a phone sharing a link) and resolve with the first link on it. */
    @PluginMethod
    public void read(PluginCall call) {
        startReader(call, null, false);
    }

    /** Wait for a sticker and write the link to it, optionally locking it so nobody can change it. */
    @PluginMethod
    public void write(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) { call.reject("Only https links can be written", "invalid_link"); return; }
        startReader(call, new NdefMessage(NdefRecord.createUri(Uri.parse(url))), Boolean.TRUE.equals(call.getBoolean("lock", false)));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        finishReader(null, "Cancelled", "cancelled");
        call.resolve();
    }

    private void startReader(PluginCall call, NdefMessage message, boolean lock) {
        NfcAdapter a = adapter();
        if (a == null) { call.reject("This phone has no NFC", "unavailable"); return; }
        if (!a.isEnabled()) { call.reject("Turn on NFC in your phone's settings", "disabled"); return; }
        finishReader(null, "Cancelled", "cancelled");
        pending = call;
        toWrite = message;
        lockAfterWrite = lock;
        Activity activity = getActivity();
        activity.runOnUiThread(() -> a.enableReaderMode(activity, this::onTag, READER_FLAGS, null));
    }

    private void onTag(Tag tag) {
        PluginCall call = pending;
        if (call == null) return;
        try {
            if (toWrite != null) {
                writeTag(tag, toWrite, lockAfterWrite);
                JSObject r = new JSObject();
                r.put("written", true);
                r.put("locked", lockAfterWrite);
                finishReader(r, null, null);
            } else {
                String url = readLink(tag);
                if (url == null) {
                    finishReader(null, "There's no link on this tag", "no_link");
                } else {
                    JSObject r = new JSObject();
                    r.put("url", url);
                    finishReader(r, null, null);
                }
            }
        } catch (IOException | FormatException e) {
            finishReader(null, "Hold the phone still against the tag and try again", "tag_lost");
        } catch (TagException e) {
            finishReader(null, e.getMessage(), e.code);
        }
    }

    private void finishReader(JSObject result, String error, String code) {
        PluginCall call = pending;
        pending = null;
        toWrite = null;
        NfcAdapter a = adapter();
        Activity activity = getActivity();
        if (a != null && activity != null) activity.runOnUiThread(() -> a.disableReaderMode(activity));
        if (call == null) return;
        if (result != null) call.resolve(result);
        else call.reject(error, code);
    }

    private static String readLink(Tag tag) throws IOException, FormatException {
        Ndef ndef = Ndef.get(tag);
        if (ndef == null) return null;
        NdefMessage msg = ndef.getCachedNdefMessage();
        if (msg == null) {
            ndef.connect();
            try {
                msg = ndef.getNdefMessage();
            } finally {
                ndef.close();
            }
        }
        if (msg == null) return null;
        for (NdefRecord r : msg.getRecords()) {
            Uri uri = r.toUri();
            if (uri != null) return uri.toString();
        }
        return null;
    }

    private static void writeTag(Tag tag, NdefMessage msg, boolean lock) throws IOException, FormatException, TagException {
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            ndef.connect();
            try {
                if (!ndef.isWritable()) throw new TagException("This sticker is locked and can't be changed", "read_only");
                if (ndef.getMaxSize() < msg.toByteArray().length) throw new TagException("This sticker is too small for the link", "too_small");
                ndef.writeNdefMessage(msg);
                if (lock && !ndef.makeReadOnly()) throw new TagException("The link was written, but this sticker can't be locked", "lock_failed");
            } finally {
                ndef.close();
            }
            return;
        }
        NdefFormatable blank = NdefFormatable.get(tag);
        if (blank == null) throw new TagException("This tag can't hold a link. Use an NFC sticker such as NTAG213.", "unsupported");
        blank.connect();
        try {
            if (lock) blank.formatReadOnly(msg);
            else blank.format(msg);
        } finally {
            blank.close();
        }
    }

    /** Stop sharing and reading when Aurex goes to the background. */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        stopSharingNow();
        finishReader(null, "Cancelled", "cancelled");
    }

    private static final class TagException extends Exception {
        final String code;

        TagException(String message, String code) {
            super(message);
            this.code = code;
        }
    }
}
