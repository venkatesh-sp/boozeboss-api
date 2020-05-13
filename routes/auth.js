var express = require('express');
var router = express.Router();
import accountController from '../controllers/accounts';

/* GET Confirm the user */
router.get('/confirmation/:token', accountController.confirmation);

/* POST Create new user. */
router.post('/signup', accountController.signup);

/* POST Create new client */
router.post('/client-signup', accountController.clientSignup);

/* POST Create new agency */
router.post('/agency-signup', accountController.agencySignup);

/* POST Guest signup */
router.post('/guest-signup', accountController.guestSignup);

/* POST Login the user. */
router.post('/login', accountController.login);

/* POST Resend the verification email */
router.post('/resend-verification', accountController.resendToken);

/* POST Resend the verification email */
router.post('/forgot', accountController.forgot);

/* POST Reset Password */
router.post('/reset', accountController.reset);

/* POST Facebook OAuth */
router.post('/facebook-oauth', accountController.authWithFacebook);


module.exports = router;