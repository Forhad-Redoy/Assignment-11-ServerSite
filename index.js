require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const port = process.env.PORT || 3000;
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
//   'utf-8'
// )
// const serviceAccount = JSON.parse(decoded)
const serviceAccount = require("./a11-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_URL, process.env.CLIENT_URL2],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("mealsDB");
    const mealsCollection = db.collection("meals");
    const orderCollection = db.collection("orders");
    const paymentCollection = db.collection("paymets");
    const usersCollection = db.collection("users");
    const roleRequestsCollection = db.collection("roles");
    const reviewsCollection = db.collection("reviews");
    const favoritesCollection = db.collection("favorites");

    await favoritesCollection.createIndex(
      { userEmail: 1, mealId: 1 },
      { unique: true }
    );
    // const { ObjectId } = require("mongodb");

    // Save all meals in db
    app.post("/meals",verifyJWT, async (req, res) => {
      const meal = req.body;
      const result = await mealsCollection.insertOne(meal);
      res.send(result);
    });

    // get all meals from db
    app.get("/meals", async (req, res) => {
      const result = await mealsCollection.find().toArray();
      res.send(result);
    });

    // get all meals from db
    app.get("/meals/:id", async (req, res) => {
      const id = req.params.id;
      const result = await mealsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // get 6 latest meals for home page
    app.get("/daily", async (req, res) => {
      try {
        const result = await mealsCollection
          .find()
          .sort({ _id: -1 }) // latest meals first
          .limit(6)
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch daily meals" });
      }
    });

    // save order in db
    app.post("/orders",verifyJWT, async (req, res) => {
      const order = req.body;
      const result = await orderCollection.insertOne(order);
      res.send(result);
    });
    // get order from db
    app.get("/my-orders/user/:email",verifyJWT, async (req, res) => {
      const email = req.params.email;

      const result = await orderCollection.find({ userEmail: email }).toArray();

      res.send(result);
    });

    // payment endpoint
    app.post("/create-checkout-session",verifyJWT, async (req, res) => {
      const { orderId } = req.body;

      const order = await orderCollection.findOne({
        _id: new ObjectId(orderId),
      });

      if (!order) return res.status(404).send({ message: "Order not found" });

      const totalAmount = order.price * order.quantity;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: order.mealName,
              },
              unit_amount: totalAmount * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          orderId: order._id.toString(),
          userEmail: order.userEmail,
        },
        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/my-orders`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success",verifyJWT, async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log("Retrieved Session:", session);

      if (session.payment_status === "paid") {
        const orderId = session.metadata.orderId;

        //  Update order: paymentStatus → "paid"
        const updateOrder = await orderCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
            },
          }
        );

        // Save payment history
        const paymentInfo = {
          orderId,
          userEmail: session.metadata.userEmail,
          amount: session.amount_total / 100,
          currency: session.currency,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          sessionId: session.id,
          paidAt: new Date(),
        };

        const resultPayment = await paymentCollection.insertOne(paymentInfo);

        // Send success response to frontend
        return res.send({
          success: true,
          message: "Payment completed and order updated.",
          orderUpdate: updateOrder,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }

      res.send({ success: false, message: "Payment not completed." });
    });

    // GET orders for a specific chef
    app.get("/chef-orders/:chefId",verifyJWT, async (req, res) => {
      const chefId = req.params.chefId;

      const result = await orderCollection
        .find({ chefId })
        .sort({ orderTime: -1 })
        .toArray();

      res.send(result);
    });

    // PATCH order status
    app.patch("/orders/:id/status",verifyJWT, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // "cancelled" | "accepted" | "delivered"

      const allowed = ["cancelled", "accepted", "delivered"];
      if (!allowed.includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const order = await orderCollection.findOne({ _id: new ObjectId(id) });
      if (!order) return res.status(404).send({ message: "Order not found" });

      // Basic rules (server-side safety)
      if (
        order.orderStatus === "cancelled" ||
        order.orderStatus === "delivered"
      ) {
        return res.status(400).send({ message: "Order already finalized" });
      }
      if (status === "delivered" && order.orderStatus !== "accepted") {
        return res.status(400).send({ message: "Must accept before deliver" });
      }

      const result = await orderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { orderStatus: status } }
      );

      res.send(result);
    });

    //  Add Review in db
    app.post("/reviews",verifyJWT, async (req, res) => {
      try {
        const review = req.body;

        // basic validation
        if (
          !review?.foodId ||
          !review?.reviewerName ||
          !review?.rating ||
          !review?.comment
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        const data = {
          foodId: new ObjectId(review.foodId),
          mealName: review.mealName || "",
          userEmail: review.userEmail || "",
          reviewerName: review.reviewerName,
          reviewerImage: review.reviewerImage || "",
          rating: Number(review.rating),
          comment: review.comment,
          date: new Date(),
        };

        const result = await reviewsCollection.insertOne(data);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //  Get reviews by meal
    app.get("/reviews/meal/:foodId", async (req, res) => {
      try {
        const foodId = new ObjectId(req.params.foodId);

        const result = await reviewsCollection.find({ foodId }).toArray();

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //  Get reviews by user (My Reviews page)
    app.get("/reviews/user/:email",verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        const result = await reviewsCollection
          .find({ userEmail: email })
          .sort({ date: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //  Delete review
    app.delete("/reviews/:id",verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await reviewsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //  Update review (rating/comment)
    app.patch("/reviews/:id",verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        const { rating, comment } = req.body;

        const updateDoc = {
          $set: {
            rating: Number(rating),
            comment,
            date: new Date().toISOString(), // optional: update time
          },
        };

        const result = await reviewsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // Add to favorites (no duplicate)
    app.post("/favorites",verifyJWT, async (req, res) => {
      req,body.userEmail =req.tokenEmail;
      try {
        const fav = req.body;

        if (!fav?.userEmail || !fav?.mealId) {
          return res
            .status(400)
            .send({ message: "Missing userEmail or mealId" });
        }

        const data = {
          userEmail: fav.userEmail,
          mealId: fav.mealId, // meal _id as string
          mealName: fav.mealName,
          chefId: fav.chefId,
          chefName: fav.chefName,
          price: fav.price || "",
          addedTime: new Date().toISOString(),
        };

        // since we created unique index, this will throw if duplicate
        const result = await favoritesCollection.insertOne(data);
        res.send({ inserted: true, result });
      } catch (err) {
        // duplicate key error
        if (err?.code === 11000) {
          return res.status(409).send({ message: "Already in favorites" });
        }
        res.status(500).send({ message: err.message });
      }
    });

    //  Get favorites by user
    app.get("/favorites/user/:email",verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        const result = await favoritesCollection
          .find({ userEmail: email })
          .sort({ addedTime: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //  Delete favorite
    app.delete("/favorites/:id", verifyJWT,async (req, res) => {
      try {
        const id = req.params.id;
        const result = await favoritesCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // get meals by chef email
    app.get("/meals/chef/:email", async (req, res) => {
      const email = req.params.email;
      const result = await mealsCollection.find({ userEmail: email }).toArray();
      res.send(result);
    });

    // delete meal create by chef
    app.delete("/meals/:id", verifyJWT,async (req, res) => {
      const id = req.params.id;
      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // update meal
    // app.patch("/meals/:id", async (req, res) => {
    //   const id = req.params.id;
    //   const updatedMeal = req.body;

    //   const result = await mealsCollection.updateOne(
    //     { _id: new ObjectId(id) },
    //     { $set: updatedMeal }
    //   );

    //   res.send(result);
    // });
    app.patch("/meals/:id",verifyJWT, async (req, res) => {
      const id = req.params.id;
      const updated = req.body;

      const updateDoc = {
        $set: {
          foodName: updated.foodName,
          chefName: updated.chefName,
          foodImage: updated.foodImage,
          price: updated.price,
          ingredients: updated.ingredients,
          estimatedDeliveryTime: updated.estimatedDeliveryTime,
          deliveryArea: updated.deliveryArea,
          chefExperience: updated.chefExperience,
          chefId: updated.chefId,
          updatedAt: new Date(),
        },
      };

      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc
      );

      res.send(result);
    });

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.email = userData.email.toLowerCase().trim();
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "user";
      userData.status = "active";
      userData.chefId = null;

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    app.get("/users/:email",verifyJWT, async (req, res) => {
      const email = req.params.email.toLowerCase().trim();

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      res.send(user);
    });
    // // POST /role-requests
    // app.post("/role-requests", async (req, res) => {
    //   const { userName, userEmail, requestType } = req.body;

    //   // optional: prevent duplicate pending requests
    //   const alreadyPending = await roleRequestsCollection.findOne({
    //     userEmail,
    //     requestType,
    //     requestStatus: "pending",
    //   });
    //   if (alreadyPending) {
    //     return res.status(409).send({ message: "Request already pending" });
    //   }

    //   const doc = {
    //     userName,
    //     userEmail,
    //     requestType, // "chef" or "admin"
    //     requestStatus: "pending",
    //     requestTime: new Date().toISOString(),
    //   };

    //   const result = await roleRequestsCollection.insertOne(doc);
    //   res.send(result);
    // });

    app.get("/users", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // make fraud
    app.patch("/users/fraud/:id", async (req, res) => {
      const { id } = req.params;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "fraud" } }
      );

      res.send(result);
    });
    // get all roll request
    app.get("/role-requests", async (req, res) => {
      const requests = await roleRequestsCollection.find().toArray();
      res.send(requests);
    });
    // approve requests
    app.patch("/role-requests/approve/:id", async (req, res) => {
      const { id } = req.params;

      const request = await roleRequestsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!request) {
        return res.status(404).send({ message: "Request not found" });
      }

      // update user role
      const updateDoc = {
        role: request.requestType,
      };

      if (request.requestType === "chef") {
        updateDoc.chefId = "chef-" + Math.floor(1000 + Math.random() * 9000);
      }

      await usersCollection.updateOne(
        { email: request.userEmail },
        { $set: updateDoc }
      );

      // update request status
      await roleRequestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { requestStatus: "approved" } }
      );

      res.send({ success: true });
    });

    // reject request
    app.patch("/role-requests/reject/:id", async (req, res) => {
      const { id } = req.params;

      await roleRequestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { requestStatus: "rejected" } }
      );

      res.send({ success: true });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
